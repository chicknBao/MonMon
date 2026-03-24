import type { PoolSnapshot, TokenDepthSnapshot } from "@monmon/shared";
import { formatUnits } from "@monmon/shared";
import type { Pool } from "pg";
import { createPublicClient, http, defineChain } from "viem";
import type { Env } from "../config.js";

import { upsertPool, upsertToken, type PoolMeta, type TokenMeta } from "../repositories/catalog.js";
import {
  upsertPoolSnapshot,
  upsertPoolSwapDepthSnapshot,
  upsertTokenDepthSnapshot,
} from "../repositories/snapshots.js";

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
    outputs: [{ name: "", type: "address[8]" }],
  },
  {
    type: "function",
    name: "get_decimals",
    stateMutability: "view",
    inputs: [{ name: "pool", type: "address" }],
    outputs: [{ name: "", type: "uint256[8]" }],
  },
  {
    type: "function",
    name: "get_balances",
    stateMutability: "view",
    inputs: [{ name: "pool", type: "address" }],
    outputs: [{ name: "", type: "uint256[8]" }],
  },
] as const;

const poolCoinsUintAbi = [
  {
    type: "function",
    name: "coins",
    stateMutability: "view",
    inputs: [{ name: "i", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

const poolCoinsInt128Abi = [
  {
    type: "function",
    name: "coins",
    stateMutability: "view",
    inputs: [{ name: "i", type: "int128" }],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

const poolBalancesUintAbi = [
  {
    type: "function",
    name: "balances",
    stateMutability: "view",
    inputs: [{ name: "i", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const poolBalancesInt128Abi = [
  {
    type: "function",
    name: "balances",
    stateMutability: "view",
    inputs: [{ name: "i", type: "int128" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const getDyInt128Abi = [
  {
    type: "function",
    name: "get_dy",
    stateMutability: "view",
    inputs: [
      { name: "i", type: "int128" },
      { name: "j", type: "int128" },
      { name: "dx", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const getDyUintAbi = [
  {
    type: "function",
    name: "get_dy",
    stateMutability: "view",
    inputs: [
      { name: "i", type: "uint256" },
      { name: "j", type: "uint256" },
      { name: "dx", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

function normalizeAddress(addr: string) {
  return addr.toLowerCase();
}

function isZeroAddress(addr: string) {
  return addr.toLowerCase() === "0x0000000000000000000000000000000000000000";
}

function parseBandList(bands: string): number[] {
  return bands
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n > 0 && n < 20000);
}

function parsePoolAddresses(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => normalizeAddress(s))
    .filter((s) => /^0x[0-9a-f]{40}$/.test(s));
}

function dxForBand(balance: bigint, bandBps: number): bigint {
  if (balance <= 0n) return 0n;
  const bps = BigInt(bandBps);
  let dx = (balance * bps) / 10_000n;
  if (dx === 0n && balance > 1n) dx = 1n;
  if (dx >= balance) dx = balance > 1n ? balance - 1n : balance;
  return dx;
}

async function readTokenMeta(publicClient: ReturnType<typeof createPublicClient>, tokenAddress: string): Promise<TokenMeta> {
  const addr = normalizeAddress(tokenAddress);
  const [decimals, symbol] = await Promise.all([
    publicClient.readContract({ address: addr as `0x${string}`, abi: erc20Abi, functionName: "decimals" }),
    publicClient.readContract({ address: addr as `0x${string}`, abi: erc20Abi, functionName: "symbol" }),
  ]);
  return { tokenAddress: addr, symbol: String(symbol), decimals: Number(decimals) };
}

async function discoverRegistryPools(
  publicClient: ReturnType<typeof createPublicClient>,
  registry: `0x${string}`,
  maxPools: number,
): Promise<string[]> {
  const code = await publicClient.getCode({ address: registry });
  if (!code || code === "0x") {
    console.log("curve: registry has no code, skipping registry discovery");
    return [];
  }

  const poolCountBn = await publicClient
    .readContract({ address: registry, abi: registryAbi, functionName: "pool_count" })
    .catch(() => 0n);
  const poolCount = Number(poolCountBn);
  if (!Number.isFinite(poolCount) || poolCount <= 0) return [];

  const out: string[] = [];
  for (let i = 0; i < poolCount; i++) {
    const pool = await publicClient.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "pool_list",
      args: [BigInt(i)],
    });
    if (!isZeroAddress(String(pool))) out.push(normalizeAddress(String(pool)));
    if (out.length >= maxPools) break;
  }
  return out;
}

async function readPoolViaRegistry(
  publicClient: ReturnType<typeof createPublicClient>,
  registry: `0x${string}`,
  poolAddress: string,
): Promise<{ tokenAddresses: string[]; tokenDecimals: number[]; balances: bigint[] } | null> {
  try {
    const [coins, decimals, balances] = await Promise.all([
      publicClient.readContract({
        address: registry,
        abi: registryAbi,
        functionName: "get_coins",
        args: [poolAddress as `0x${string}`],
      }),
      publicClient.readContract({
        address: registry,
        abi: registryAbi,
        functionName: "get_decimals",
        args: [poolAddress as `0x${string}`],
      }),
      publicClient.readContract({
        address: registry,
        abi: registryAbi,
        functionName: "get_balances",
        args: [poolAddress as `0x${string}`],
      }),
    ]);

    const tokenAddresses: string[] = [];
    const tokenDecimals: number[] = [];
    const balOut: bigint[] = [];

    for (let idx = 0; idx < coins.length; idx++) {
      const c = coins[idx];
      if (isZeroAddress(String(c))) break;
      tokenAddresses.push(normalizeAddress(String(c)));
      tokenDecimals.push(Number((decimals as readonly bigint[])[idx] ?? 18n));
      balOut.push(BigInt((balances as readonly bigint[])[idx] ?? 0n));
    }

    if (tokenAddresses.length < 2) return null;
    return { tokenAddresses, tokenDecimals, balances: balOut };
  } catch {
    return null;
  }
}

async function readCoinAtIndex(
  publicClient: ReturnType<typeof createPublicClient>,
  pool: `0x${string}`,
  i: number,
): Promise<string | null> {
  try {
    const a = await publicClient.readContract({
      address: pool,
      abi: poolCoinsUintAbi,
      functionName: "coins",
      args: [BigInt(i)],
    });
    const s = normalizeAddress(String(a));
    return isZeroAddress(s) ? null : s;
  } catch {
    try {
      const a = await publicClient.readContract({
        address: pool,
        abi: poolCoinsInt128Abi,
        functionName: "coins",
        args: [BigInt(i)],
      });
      const s = normalizeAddress(String(a));
      return isZeroAddress(s) ? null : s;
    } catch {
      return null;
    }
  }
}

async function readBalanceAtIndex(
  publicClient: ReturnType<typeof createPublicClient>,
  pool: `0x${string}`,
  i: number,
): Promise<bigint | null> {
  try {
    return await publicClient.readContract({
      address: pool,
      abi: poolBalancesUintAbi,
      functionName: "balances",
      args: [BigInt(i)],
    });
  } catch {
    try {
      return await publicClient.readContract({
        address: pool,
        abi: poolBalancesInt128Abi,
        functionName: "balances",
        args: [BigInt(i)],
      });
    } catch {
      return null;
    }
  }
}

async function readPoolDirect(
  publicClient: ReturnType<typeof createPublicClient>,
  poolAddress: string,
): Promise<{ tokenAddresses: string[]; balances: bigint[] } | null> {
  const pool = poolAddress as `0x${string}`;
  const tokenAddresses: string[] = [];
  const balances: bigint[] = [];

  for (let i = 0; i < 8; i++) {
    const coin = await readCoinAtIndex(publicClient, pool, i);
    if (!coin) break;
    const bal = await readBalanceAtIndex(publicClient, pool, i);
    if (bal === null) break;
    tokenAddresses.push(coin);
    balances.push(bal);
  }

  if (tokenAddresses.length < 2) return null;
  return { tokenAddresses, balances };
}

async function getDy(
  publicClient: ReturnType<typeof createPublicClient>,
  pool: `0x${string}`,
  i: number,
  j: number,
  dx: bigint,
): Promise<bigint | null> {
  if (dx <= 0n) return 0n;
  try {
    return await publicClient.readContract({
      address: pool,
      abi: getDyInt128Abi,
      functionName: "get_dy",
      args: [BigInt(i), BigInt(j), dx],
    });
  } catch {
    try {
      return await publicClient.readContract({
        address: pool,
        abi: getDyUintAbi,
        functionName: "get_dy",
        args: [BigInt(i), BigInt(j), dx],
      });
    } catch {
      return null;
    }
  }
}

export async function runCurveDepthSnapshot(params: { env: Env; db: Pool }) {
  const { env, db } = params;

  const registryRaw = env.CURVE_REGISTRY?.trim();
  const explicitPools = parsePoolAddresses(env.CURVE_POOL_ADDRESSES);
  if (!registryRaw && explicitPools.length === 0) {
    console.log("curve: CURVE_REGISTRY and CURVE_POOL_ADDRESSES unset — skipping Curve snapshot");
    return;
  }

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

  const fromRegistry =
    registryRaw && /^0x[0-9a-fA-F]{40}$/.test(registryRaw)
      ? await discoverRegistryPools(publicClient, registryRaw as `0x${string}`, env.DISCOVERY_MAX_POOLS)
      : [];

  const poolAddresses = [...new Set([...fromRegistry, ...explicitPools])].slice(0, env.DISCOVERY_MAX_POOLS);

  if (poolAddresses.length === 0) {
    console.log("curve: no pools discovered (check CURVE_REGISTRY / CURVE_POOL_ADDRESSES)");
    return;
  }

  console.log(`curve: snapshotting ${poolAddresses.length} pools`);
  const registryAddr = registryRaw && /^0x[0-9a-fA-F]{40}$/.test(registryRaw) ? (registryRaw as `0x${string}`) : null;

  const nowIso = new Date().toISOString();
  const depthSimpleBps = env.DEPTH_SIMPLE_BAND_BPS;

  for (let i = 0; i < poolAddresses.length; i += env.SNAPSHOT_BATCH_SIZE) {
    const batch = poolAddresses.slice(i, i + env.SNAPSHOT_BATCH_SIZE);
    await Promise.allSettled(
      batch.map(async (poolAddress) => {
        let tokenAddresses: string[] = [];
        let balances: bigint[] = [];
        let registryDecimals: number[] | undefined;

        if (registryAddr) {
          const viaReg = await readPoolViaRegistry(publicClient, registryAddr, poolAddress);
          if (viaReg) {
            tokenAddresses = viaReg.tokenAddresses;
            balances = viaReg.balances;
            registryDecimals = viaReg.tokenDecimals;
          }
        }

        if (tokenAddresses.length < 2) {
          const direct = await readPoolDirect(publicClient, poolAddress);
          if (!direct) return;
          tokenAddresses = direct.tokenAddresses;
          balances = direct.balances;
          registryDecimals = undefined;
        }

        const tokenMetaList: TokenMeta[] = await Promise.all(
          tokenAddresses.map(async (tokenAddress, idx) => {
            try {
              return await readTokenMeta(publicClient, tokenAddress);
            } catch {
              return {
                tokenAddress,
                symbol: tokenAddress.slice(0, 6),
                decimals: registryDecimals?.[idx] ?? 18,
              };
            }
          }),
        );

        const poolMeta: PoolMeta = {
          poolAddress,
          dex: "curve",
          tokenAddresses,
        };

        await Promise.all([upsertPool(db, poolMeta), ...tokenMetaList.map((t) => upsertToken(db, t))]);

        const tokenAmountsRaw = new Map<string, bigint>();
        for (let idx = 0; idx < tokenAddresses.length; idx++) {
          tokenAmountsRaw.set(tokenAddresses[idx], balances[idx] ?? 0n);
        }

        const tokenAmounts: Record<string, string> = {};
        for (const [tAddr, amtRaw] of tokenAmountsRaw.entries()) tokenAmounts[tAddr] = amtRaw.toString();

        await upsertPoolSnapshot(db, {
          timestamp: nowIso,
          dex: "curve",
          poolAddress,
          tokenAmounts,
        });

        const depthSimpleByToken: Record<string, string> = {};
        for (let idx = 0; idx < tokenAddresses.length; idx++) {
          const tAddr = tokenAddresses[idx];
          const decimals = tokenMetaList[idx]!.decimals;
          const amtRaw = tokenAmountsRaw.get(tAddr) ?? 0n;
          depthSimpleByToken[tAddr] = formatUnits(amtRaw, decimals);
        }

        await Promise.all(
          bandList.map(async (bandBps) => {
            await Promise.all(
              tokenAddresses.map(async (tAddr) => {
                const depthSimple = depthSimpleByToken[tAddr]!;
                const snap: TokenDepthSnapshot = {
                  timestamp: nowIso,
                  dex: "curve",
                  tokenAddress: tAddr,
                  bandBps,
                  depthSimple,
                  depthBand: depthSimple,
                };
                await upsertTokenDepthSnapshot(db, snap);
              }),
            );
          }),
        );

        const pool = poolAddress as `0x${string}`;
        const n = tokenAddresses.length;

        for (let a = 0; a < n; a++) {
          for (let b = 0; b < n; b++) {
            if (a === b) continue;
            const inAddr = tokenAddresses[a]!;
            const outAddr = tokenAddresses[b]!;
            const decOut = tokenMetaList[b]!.decimals;
            const balIn = balances[a] ?? 0n;

            for (const bandBps of bandList) {
              const dxBand = dxForBand(balIn, bandBps);
              const dyBand = await getDy(publicClient, pool, a, b, dxBand);
              const depthBand =
                dyBand !== null ? formatUnits(dyBand, decOut) : "0";

              const dxSimple = dxForBand(balIn, depthSimpleBps);
              const dySimple = await getDy(publicClient, pool, a, b, dxSimple);
              const depthSimple =
                dySimple !== null ? formatUnits(dySimple, decOut) : "0";

              await upsertPoolSwapDepthSnapshot(db, {
                timestamp: nowIso,
                dex: "curve",
                poolAddress,
                bandBps,
                tokenIn: inAddr,
                tokenOut: outAddr,
                depthSimple,
                depthBand,
              });
            }
          }
        }
      }),
    );
  }
}
