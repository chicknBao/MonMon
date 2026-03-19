import type { Pool } from "pg";
import type { Env } from "../config.js";

import { createPublicClient, defineChain, http } from "viem";
import { formatUnits, isUniswapV4PoolAllowed, uniswapV3DirectionalMaxOutputRaw } from "@monmon/shared";
import { upsertPool, upsertToken, type PoolMeta, type TokenMeta } from "../repositories/catalog.js";
import { upsertPoolSwapDepthSnapshot } from "../repositories/snapshots.js";

// MVP adapter for Uniswap v4:
// - Uses PositionManager.poolKeys(poolIdBytes25) to get currency0/currency1 without log scanning.
// - Uses StateView.getSlot0(poolId) and StateView.getLiquidity(poolId) for sqrtPrice + active liquidity.
// - Computes directional max output within a sqrt-price band with constant-liquidity sqrt-bound math.

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

const positionManagerAbi = [
  {
    type: "function",
    name: "poolKeys",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes25" }],
    outputs: [
      { name: "currency0", type: "address" },
      { name: "currency1", type: "address" },
      { name: "fee", type: "uint24" },
      { name: "tickSpacing", type: "int24" },
      { name: "hooks", type: "address" },
    ],
  },
] as const;

const stateViewAbi = [
  {
    type: "function",
    name: "getSlot0",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "protocolFee", type: "uint24" },
      { name: "lpFee", type: "uint24" },
    ],
  },
  {
    type: "function",
    name: "getLiquidity",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [{ name: "liquidity", type: "uint128" }],
  },
] as const;

const NATIVE_CURRENCY = "0x0000000000000000000000000000000000000000";

function normalizeAddress(addr: string) {
  return addr.toLowerCase();
}

function parsePoolIds(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => normalizeAddress(s))
    .filter((s) => /^0x[0-9a-fA-F]{64}$/.test(s));
}

function v4PoolAddress(poolId: string) {
  return `v4:${poolId.toLowerCase()}`;
}

function parseBandList(bands: string): number[] {
  return bands
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n > 0 && n < 20000);
}

function truncatePoolIdToBytes25(corePoolId: string): `0x${string}` {
  // PositionInfoLibrary truncates bytes32 poolId to bytes25 by using the most-significant 200 bits.
  // In practice this is equivalent to shifting right by 56 bits (dropping the lower 56 bits).
  const core = BigInt(corePoolId);
  const bytes25 = core >> 56n; // 200 bits
  return `0x${bytes25.toString(16).padStart(50, "0")}` as `0x${string}`;
}

async function readTokenMeta(publicClient: ReturnType<typeof createPublicClient>, tokenAddress: string): Promise<TokenMeta> {
  const addr = normalizeAddress(tokenAddress);
  if (addr === NATIVE_CURRENCY) return { tokenAddress: addr, symbol: "MON", decimals: 18 };

  const [decimals, symbol] = await Promise.all([
    publicClient.readContract({ address: addr as `0x${string}`, abi: erc20Abi, functionName: "decimals" }),
    publicClient.readContract({ address: addr as `0x${string}`, abi: erc20Abi, functionName: "symbol" }),
  ]);

  return { tokenAddress: addr, symbol: String(symbol), decimals: Number(decimals) };
}

export async function runUniswapV4DepthSnapshot(params: { env: Env; db: Pool }) {
  const { env, db } = params;

  const poolIds = parsePoolIds(env.UNISWAP_V4_POOL_IDS);
  if (poolIds.length === 0) return;

  if (!env.UNISWAP_V4_STATE_VIEW) throw new Error("UNISWAP_V4_STATE_VIEW is required for uniswap_v4 snapshots");
  if (!env.UNISWAP_V4_POSITION_MANAGER) throw new Error("UNISWAP_V4_POSITION_MANAGER is required for uniswap_v4 snapshots");

  const monadChain = defineChain({
    id: env.MONAD_CHAIN_ID,
    name: "Monad",
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [env.MONAD_RPC_URL] } },
  });

  const publicClient = createPublicClient({
    chain: monadChain,
    transport: http(env.MONAD_RPC_URL),
  });

  const bandList = parseBandList(env.BAND_BPS_LIST);
  if (bandList.length === 0) return;

  const nowIso = new Date().toISOString();
  const depthSimpleBps = env.DEPTH_SIMPLE_BAND_BPS;

  for (const poolId of poolIds) {
    const poolIdBytes25 = truncatePoolIdToBytes25(poolId);

    const [poolKeys, slot0, liquidity] = await Promise.all([
      publicClient.readContract({
        address: env.UNISWAP_V4_POSITION_MANAGER as `0x${string}`,
        abi: positionManagerAbi,
        functionName: "poolKeys",
        args: [poolIdBytes25],
      }),
      publicClient.readContract({
        address: env.UNISWAP_V4_STATE_VIEW as `0x${string}`,
        abi: stateViewAbi,
        functionName: "getSlot0",
        args: [poolId as `0x${string}`],
      }),
      publicClient.readContract({
        address: env.UNISWAP_V4_STATE_VIEW as `0x${string}`,
        abi: stateViewAbi,
        functionName: "getLiquidity",
        args: [poolId as `0x${string}`],
      }),
    ]);

    const currency0Addr = normalizeAddress(String(poolKeys[0]));
    const currency1Addr = normalizeAddress(String(poolKeys[1]));

    const [token0Meta, token1Meta] = await Promise.all([
      readTokenMeta(publicClient, currency0Addr),
      readTokenMeta(publicClient, currency1Addr),
    ]);

    if (!isUniswapV4PoolAllowed(token0Meta.symbol, token1Meta.symbol)) {
      continue;
    }

    const sqrtPriceX96 = BigInt((slot0 as any)[0]);
    const liquidityBigInt = BigInt(liquidity as any);

    const poolAddress = v4PoolAddress(poolId);
    const poolMeta: PoolMeta = {
      poolAddress,
      dex: "uniswap_v4",
      tokenAddresses: [token0Meta.tokenAddress, token1Meta.tokenAddress],
    };

    await Promise.all([upsertToken(db, token0Meta), upsertToken(db, token1Meta), upsertPool(db, poolMeta)]);

    for (const bandBps of bandList) {
      const outToken0To1Raw = uniswapV3DirectionalMaxOutputRaw({
        liquidity: liquidityBigInt,
        sqrtPriceX96,
        bandBps,
        direction: "token0to1",
      });
      const outToken1To0Raw = uniswapV3DirectionalMaxOutputRaw({
        liquidity: liquidityBigInt,
        sqrtPriceX96,
        bandBps,
        direction: "token1to0",
      });

      const outDepthSimpleToken0To1Raw = uniswapV3DirectionalMaxOutputRaw({
        liquidity: liquidityBigInt,
        sqrtPriceX96,
        bandBps: depthSimpleBps,
        direction: "token0to1",
      });
      const outDepthSimpleToken1To0Raw = uniswapV3DirectionalMaxOutputRaw({
        liquidity: liquidityBigInt,
        sqrtPriceX96,
        bandBps: depthSimpleBps,
        direction: "token1to0",
      });

      await Promise.all([
        upsertPoolSwapDepthSnapshot(db, {
          timestamp: nowIso,
          dex: "uniswap_v4",
          poolAddress,
          bandBps,
          tokenIn: token0Meta.tokenAddress,
          tokenOut: token1Meta.tokenAddress,
          depthSimple: formatUnits(outDepthSimpleToken0To1Raw, token1Meta.decimals),
          depthBand: formatUnits(outToken0To1Raw, token1Meta.decimals),
        }),
        upsertPoolSwapDepthSnapshot(db, {
          timestamp: nowIso,
          dex: "uniswap_v4",
          poolAddress,
          bandBps,
          tokenIn: token1Meta.tokenAddress,
          tokenOut: token0Meta.tokenAddress,
          depthSimple: formatUnits(outDepthSimpleToken1To0Raw, token0Meta.decimals),
          depthBand: formatUnits(outToken1To0Raw, token0Meta.decimals),
        }),
      ]);
    }
  }
}

