import type { PoolSwapDepthSnapshot } from "@monmon/shared";
import { formatUnits, uniswapV3DirectionalMaxOutputRaw } from "@monmon/shared";
import type { Pool } from "pg";
import type { Env } from "../config.js";
import { createMonadPublicClient } from "../monadPublicClient.js";

import { upsertPool, upsertToken, type PoolMeta, type TokenMeta } from "../repositories/catalog.js";
import {
  upsertPoolSwapDepthSnapshot,
} from "../repositories/snapshots.js";

// WMON on Monad (native MON is 0x000...000; pools use WMON/WMON).
const WMON = "0x3bd359c1119da7da1d913d1c4d2b7c461115433a";

// PancakeSwap v3 (Monad)
const PANCAKE_V3_FACTORY = "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865";

const erc20Abi = [
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
] as const;

const pancakeV3FactoryAbi = [
  {
    type: "function",
    name: "getPool",
    stateMutability: "view",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
      { name: "fee", type: "uint24" },
    ],
    outputs: [{ name: "pool", type: "address" }],
  },
] as const;

const uniswapV3PoolAbi = [
  {
    type: "function",
    name: "token0",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "token1",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "liquidity",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint128" }],
  },
  {
    type: "function",
    name: "slot0",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "feeProtocol", type: "uint8" },
      { name: "unlocked", type: "bool" },
    ],
  },
] as const;

function normalizeAddress(addr: string) {
  return addr.toLowerCase();
}

function sortTwoTokenAddresses(a: string, b: string): [`0x${string}`, `0x${string}`] {
  const aa = a.toLowerCase();
  const bb = b.toLowerCase();
  return aa < bb ? [aa as `0x${string}`, bb as `0x${string}`] : [bb as `0x${string}`, aa as `0x${string}`];
}

function parseBandList(bands: string): number[] {
  return bands
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n > 0 && n < 20000);
}

async function readTokenMeta(
  publicClient: ReturnType<typeof createMonadPublicClient>,
  tokenAddress: string,
): Promise<TokenMeta> {
  const addr = normalizeAddress(tokenAddress);
  const [decimals, symbol] = await Promise.all([
    publicClient.readContract({
      address: addr as `0x${string}`,
      abi: erc20Abi,
      functionName: "decimals",
    }),
    publicClient.readContract({
      address: addr as `0x${string}`,
      abi: erc20Abi,
      functionName: "symbol",
    }),
  ]);
  return { tokenAddress: addr, symbol: String(symbol), decimals: Number(decimals) };
}

/**
 * Pancake v3 MVP adapter:
 * - Discover pools via `factory.getPool( tokenA, tokenB, fee )` for WMON against common quote tokens.
 * - Use the shared Uniswap-v3 depth approximation (constant active liquidity) for directional "max output within band".
 *
 * Note: This intentionally only targets MON/WMON liquidity (via WMON in pool addresses).
 */
export async function runPancakeDepthSnapshot(params: { env: Env; db: Pool; snapshotTs?: string }) {
  const { env, db, snapshotTs } = params;

  const bandList = parseBandList(env.BAND_BPS_LIST);
  if (bandList.length === 0) throw new Error("BAND_BPS_LIST produced no valid bands");

  const depthSimpleBps = env.DEPTH_SIMPLE_BAND_BPS;

  const nowIso = snapshotTs ?? new Date().toISOString();

  const publicClient = createMonadPublicClient(env);

  // MVP discovery scope: WMON against common stables (enough to populate the swap dashboard for MON/WMON exit liquidity).
  const quoteTokens = [
    "0x754704bc059f8c67012fed69bc8a327a5aafb603", // USDC
    "0xe7cd86e13ac4309349f30b3435a9d337750fc82d", // USDT
    "0x00000000efe302beaa2b3e6e1b18d08d69a9012a", // AUSD
  ];

  const feeTiers = [100, 500, 2500, 10000] as const;

  const pools = new Map<string, { poolAddress: string; token0: string; token1: string }>();

  for (const quote of quoteTokens) {
    const [a, b] = sortTwoTokenAddresses(WMON, quote);
    for (const fee of feeTiers) {
      const poolAddr = await publicClient.readContract({
        address: PANCAKE_V3_FACTORY as `0x${string}`,
        abi: pancakeV3FactoryAbi,
        functionName: "getPool",
        args: [a, b, fee],
      });

      const poolAddress = normalizeAddress(String(poolAddr));
      if (!poolAddress || poolAddress === "0x0000000000000000000000000000000000000000") continue;

      const code = await publicClient.getCode({ address: poolAddress as `0x${string}` });
      if (!code || code === "0x") continue;

      if (pools.has(poolAddress)) continue;

      const [token0, token1] = await Promise.all([
        publicClient.readContract({
          address: poolAddress as `0x${string}`,
          abi: uniswapV3PoolAbi,
          functionName: "token0",
        }),
        publicClient.readContract({
          address: poolAddress as `0x${string}`,
          abi: uniswapV3PoolAbi,
          functionName: "token1",
        }),
      ]);

      pools.set(poolAddress, {
        poolAddress,
        token0: normalizeAddress(String(token0)),
        token1: normalizeAddress(String(token1)),
      });
    }
  }

  console.log(`Pancake v3 discovered ${pools.size} MON/WMON pools`);

  const poolList = [...pools.values()];

  for (let i = 0; i < poolList.length; i += env.SNAPSHOT_BATCH_SIZE) {
    const batch = poolList.slice(i, i + env.SNAPSHOT_BATCH_SIZE);
    await Promise.allSettled(
      batch.map(async ({ poolAddress, token0, token1 }) => {
        // Read pool state for directional max output.
        const [liquidity, slot0] = await Promise.all([
          publicClient.readContract({
            address: poolAddress as `0x${string}`,
            abi: uniswapV3PoolAbi,
            functionName: "liquidity",
          }),
          publicClient.readContract({
            address: poolAddress as `0x${string}`,
            abi: uniswapV3PoolAbi,
            functionName: "slot0",
          }),
        ]);

        const sqrtPriceX96 = (slot0 as readonly unknown[])[0] as bigint;
        const liquidityBig = liquidity as bigint;

        if (liquidityBig <= 0n || sqrtPriceX96 <= 0n) return;

        const [token0Meta, token1Meta] = await Promise.all([
          readTokenMeta(publicClient, token0),
          readTokenMeta(publicClient, token1),
        ]);

        const poolMeta: PoolMeta = {
          poolAddress,
          dex: "pancake",
          tokenAddresses: [token0Meta.tokenAddress, token1Meta.tokenAddress],
        };

        await Promise.all([
          upsertPool(db, poolMeta),
          upsertToken(db, token0Meta),
          upsertToken(db, token1Meta),
        ]);

        // Directional max outputs for the constant active liquidity approximation.
        const depthSimpleToken0To1Raw = uniswapV3DirectionalMaxOutputRaw({
          liquidity: liquidityBig,
          sqrtPriceX96,
          bandBps: depthSimpleBps,
          direction: "token0to1",
        });
        const depthSimpleToken1To0Raw = uniswapV3DirectionalMaxOutputRaw({
          liquidity: liquidityBig,
          sqrtPriceX96,
          bandBps: depthSimpleBps,
          direction: "token1to0",
        });

        const depthSimpleToken0To1 = formatUnits(depthSimpleToken0To1Raw, token1Meta.decimals);
        const depthSimpleToken1To0 = formatUnits(depthSimpleToken1To0Raw, token0Meta.decimals);

        const upserts: Array<Promise<unknown>> = [];

        for (const bandBps of bandList) {
          const depthToken0To1Raw = uniswapV3DirectionalMaxOutputRaw({
            liquidity: liquidityBig,
            sqrtPriceX96,
            bandBps,
            direction: "token0to1",
          });
          const depthToken1To0Raw = uniswapV3DirectionalMaxOutputRaw({
            liquidity: liquidityBig,
            sqrtPriceX96,
            bandBps,
            direction: "token1to0",
          });

          const depthToken0To1 = formatUnits(depthToken0To1Raw, token1Meta.decimals);
          const depthToken1To0 = formatUnits(depthToken1To0Raw, token0Meta.decimals);

          const snap0To1: PoolSwapDepthSnapshot = {
            timestamp: nowIso,
            dex: "pancake",
            poolAddress,
            bandBps,
            tokenIn: token0Meta.tokenAddress,
            tokenOut: token1Meta.tokenAddress,
            depthSimple: depthSimpleToken0To1,
            depthBand: depthToken0To1,
          };
          const snap1To0: PoolSwapDepthSnapshot = {
            timestamp: nowIso,
            dex: "pancake",
            poolAddress,
            bandBps,
            tokenIn: token1Meta.tokenAddress,
            tokenOut: token0Meta.tokenAddress,
            depthSimple: depthSimpleToken1To0,
            depthBand: depthToken1To0,
          };

          upserts.push(upsertPoolSwapDepthSnapshot(db, snap0To1));
          upserts.push(upsertPoolSwapDepthSnapshot(db, snap1To0));
        }

        await Promise.all(upserts);
      }),
    );
  }
}

