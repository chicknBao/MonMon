import type { PoolSnapshot, TokenDepthSnapshot } from "@monmon/shared";
import { formatUnits } from "@monmon/shared";
import type { Pool } from "pg";
import { createPublicClient, http, defineChain } from "viem";
import type { Env } from "../config";

import { upsertPool, upsertToken, type PoolMeta, type TokenMeta } from "../repositories/catalog";
import { upsertPoolSnapshot, upsertTokenDepthSnapshot } from "../repositories/snapshots";

const CURVE_REGISTRY = "0x90E00ACe148ca3b23Ac1bC8C240C2a7Dd9c2d7f5";

const registryAbi = [
  {
    type: "function",
    name: "pool_count",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "pool_list",
    stateMutability: "view",
    inputs: [{ name: "i", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "get_coins",
    stateMutability: "view",
    inputs: [{ name: "pool", type: "address" }],
    outputs: [
      { name: "", type: "address[8]" },
    ],
  },
  {
    type: "function",
    name: "get_decimals",
    stateMutability: "view",
    inputs: [{ name: "pool", type: "address" }],
    outputs: [
      { name: "", type: "uint256[8]" },
    ],
  },
  {
    type: "function",
    name: "get_balances",
    stateMutability: "view",
    inputs: [{ name: "pool", type: "address" }],
    outputs: [
      { name: "", type: "uint256[8]" },
    ],
  },
] as const;

function parseBandList(bands: string): number[] {
  return bands
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n > 0 && n < 20000);
}

function isZeroAddress(addr: string) {
  return addr.toLowerCase() === "0x0000000000000000000000000000000000000000";
}

async function readRegistryPoolInfo(publicClient: ReturnType<typeof createPublicClient>, poolAddress: string) {
  const [coins, decimals, balances] = await Promise.all([
    publicClient.readContract({
      address: CURVE_REGISTRY as `0x${string}`,
      abi: registryAbi,
      functionName: "get_coins",
      args: [poolAddress as `0x${string}`],
    }),
    publicClient.readContract({
      address: CURVE_REGISTRY as `0x${string}`,
      abi: registryAbi,
      functionName: "get_decimals",
      args: [poolAddress as `0x${string}`],
    }),
    publicClient.readContract({
      address: CURVE_REGISTRY as `0x${string}`,
      abi: registryAbi,
      functionName: "get_balances",
      args: [poolAddress as `0x${string}`],
    }),
  ]);

  const tokenAddresses = coins.filter((c) => !isZeroAddress(c)) as string[];
  const tokenDecimals = tokenAddresses.map((t) => {
    const idx = coins.findIndex((c) => c.toLowerCase() === t.toLowerCase());
    return Number((decimals as readonly bigint[])[idx] ?? 18n);
  });
  const tokenAmountsRaw = new Map<string, bigint>();
  for (let idx = 0; idx < coins.length; idx++) {
    const coin = coins[idx];
    if (isZeroAddress(coin)) continue;
    tokenAmountsRaw.set(coin.toLowerCase(), (balances as readonly bigint[])[idx]);
  }

  return { tokenAddresses: tokenAddresses.map((a) => a.toLowerCase()), tokenDecimals, tokenAmountsRaw };
}

export async function runCurveDepthSnapshot(params: { env: Env; db: Pool }) {
  const { env, db } = params;
  const bandList = parseBandList(env.BAND_BPS_LIST);
  if (bandList.length === 0) throw new Error("BAND_BPS_LIST produced no valid bands");

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

  const poolCount = Number(
    await publicClient.readContract({
      address: CURVE_REGISTRY as `0x${string}`,
      abi: registryAbi,
      functionName: "pool_count",
    }),
  );

  console.log(`Curve registry reports ${poolCount} pools`);

  const poolAddresses: string[] = [];
  for (let i = 0; i < poolCount; i++) {
    const pool = await publicClient.readContract({
      address: CURVE_REGISTRY as `0x${string}`,
      abi: registryAbi,
      functionName: "pool_list",
      args: [BigInt(i)],
    });
    if (!isZeroAddress(String(pool))) poolAddresses.push(String(pool).toLowerCase());
    if (poolAddresses.length >= env.DISCOVERY_MAX_POOLS) break;
  }

  const nowIso = new Date().toISOString();

  for (let i = 0; i < poolAddresses.length; i += env.SNAPSHOT_BATCH_SIZE) {
    const batch = poolAddresses.slice(i, i + env.SNAPSHOT_BATCH_SIZE);
    await Promise.allSettled(
      batch.map(async (poolAddress) => {
        const { tokenAddresses, tokenDecimals, tokenAmountsRaw } = await readRegistryPoolInfo(publicClient, poolAddress);
        if (tokenAddresses.length < 2) return;

        const tokenMetaList: TokenMeta[] = tokenAddresses.map((tokenAddress, idx) => ({
          tokenAddress,
          symbol: tokenAddress.slice(0, 6), // MVP: symbol lookup can be added later
          name: undefined,
          decimals: tokenDecimals[idx],
        }));

        const poolMeta: PoolMeta = {
          poolAddress,
          dex: "curve",
          tokenAddresses,
        };

        await Promise.all([
          upsertPool(db, poolMeta),
          ...tokenMetaList.map((t) => upsertToken(db, t)),
        ]);

        const tokenAmounts: Record<string, string> = {};
        for (const [tAddr, amtRaw] of tokenAmountsRaw.entries()) tokenAmounts[tAddr] = amtRaw.toString();

        const poolSnap: PoolSnapshot = {
          timestamp: nowIso,
          dex: "curve",
          poolAddress,
          tokenAmounts,
        };
        await upsertPoolSnapshot(db, poolSnap);

        // MVP: Curve "depthBand" is approximated as equal to depthSimple (pool balances)
        // since band-specific reserve math requires deeper pool parameter introspection.
        const depthSimpleByToken: Record<string, string> = {};
        for (let idx = 0; idx < tokenAddresses.length; idx++) {
          const tAddr = tokenAddresses[idx];
          const decimals = tokenDecimals[idx];
          const amtRaw = tokenAmountsRaw.get(tAddr) ?? 0n;
          depthSimpleByToken[tAddr] = formatUnits(amtRaw, decimals);
        }

        await Promise.all(
          bandList.map(async (bandBps) => {
            await Promise.all(
              tokenAddresses.map(async (tAddr) => {
                const depthSimple = depthSimpleByToken[tAddr];
                const depthBand = depthSimple; // approximation
                const snap: TokenDepthSnapshot = {
                  timestamp: nowIso,
                  dex: "curve",
                  tokenAddress: tAddr,
                  bandBps,
                  depthSimple,
                  depthBand,
                };
                await upsertTokenDepthSnapshot(db, snap);
              }),
            );
          }),
        );
      }),
    );
  }
}

