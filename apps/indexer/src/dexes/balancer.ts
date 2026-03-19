import type { PoolSnapshot, TokenDepthSnapshot } from "@monmon/shared";
import { formatUnits } from "@monmon/shared";
import type { Pool } from "pg";
import { createPublicClient, defineChain, decodeEventLog, http, keccak256, toBytes, toHex } from "viem";
import type { Env } from "../config.js";

import { upsertPool, upsertToken } from "../repositories/catalog.js";
import { upsertPoolSnapshot, upsertTokenDepthSnapshot } from "../repositories/snapshots.js";
import type { TokenMeta, PoolMeta } from "../repositories/catalog.js";

const BALANCER_VAULT_V2 = "0xba12222222228d8Ba445958a75a0704d566BF2C8";

const vaultAbi = [
  {
    type: "event",
    name: "PoolRegistered",
    inputs: [
      { name: "poolId", type: "bytes32", indexed: true },
      { name: "poolAddress", type: "address", indexed: true },
      { name: "specialization", type: "uint8", indexed: false },
    ],
  },
  {
    type: "function",
    name: "getPoolTokens",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [
      { name: "tokens", type: "address[]" },
      { name: "balances", type: "uint256[]" },
      { name: "lastChangeBlock", type: "uint256" },
    ],
  },
] as const;

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

function normalizeAddress(addr: string) {
  return addr.toLowerCase();
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
  publicClient: ReturnType<typeof createPublicClient>,
  tokenAddress: string,
): Promise<TokenMeta> {
  const addr = normalizeAddress(tokenAddress);
  const [decimals, symbol] = await Promise.all([
    publicClient.readContract({ address: addr as `0x${string}`, abi: erc20Abi, functionName: "decimals" }),
    publicClient.readContract({ address: addr as `0x${string}`, abi: erc20Abi, functionName: "symbol" }),
  ]);
  return { tokenAddress: addr, symbol: String(symbol), decimals: Number(decimals) };
}

export async function runBalancerDepthSnapshot(params: { env: Env; db: Pool }) {
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

  const latestBlock = await publicClient.getBlockNumber();
  const lookback = BigInt(env.DISCOVERY_LOOKBACK_BLOCKS);
  const fromBlock = latestBlock > lookback ? latestBlock - lookback : 0n;
  const toBlock = latestBlock;

  const poolRegisteredTopic0 = keccak256(toBytes("PoolRegistered(bytes32,address,uint8)"));

  const logs = (await publicClient.request({
    method: "eth_getLogs",
    params: [
      {
        address: BALANCER_VAULT_V2,
        fromBlock: toHex(fromBlock),
        toBlock: toHex(toBlock),
        topics: [poolRegisteredTopic0],
      },
    ],
  })) as Array<{ data: string; topics: string[] }>;

  const pools = new Map<string, { poolId: string; poolAddress: string; specialization: number }>();
  for (const log of logs) {
    const decoded = decodeEventLog({
      abi: vaultAbi,
      eventName: "PoolRegistered",
      data: log.data as `0x${string}`,
      topics: log.topics as unknown as [`0x${string}`, ...`0x${string}`[]],
    });
    const poolId = String(decoded.args.poolId).toLowerCase();
    const poolAddress = normalizeAddress(String(decoded.args.poolAddress));
    const specialization = Number(decoded.args.specialization);
    // MVP: focus on Two-Tokens pools for simpler token liquidity interpretation.
    if (specialization !== 2) continue;
    pools.set(poolId, { poolId, poolAddress, specialization });
    if (pools.size >= env.DISCOVERY_MAX_POOLS) break;
  }

  console.log(`Balancer v2 discovered ${pools.size} pools`);

  const nowIso = new Date().toISOString();
  const tokenMetaCache = new Map<string, TokenMeta>();

  const poolList = Array.from(pools.values());
  for (let i = 0; i < poolList.length; i += env.SNAPSHOT_BATCH_SIZE) {
    const batch = poolList.slice(i, i + env.SNAPSHOT_BATCH_SIZE);
    await Promise.allSettled(
      batch.map(async ({ poolId, poolAddress }) => {
        const [tokens, balances] = (await publicClient.readContract({
          address: BALANCER_VAULT_V2 as `0x${string}`,
          abi: vaultAbi,
          functionName: "getPoolTokens",
          args: [poolId as `0x${string}`],
        })) as [string[], bigint[], unknown];

        const tokenAddresses = tokens
          .map((t) => normalizeAddress(String(t)))
          .filter((t) => t !== "0x0000000000000000000000000000000000000000");

        const balancesByToken = new Map<string, bigint>();
        for (let idx = 0; idx < tokens.length; idx++) {
          const t = normalizeAddress(String(tokens[idx]));
          balancesByToken.set(t, (balances as bigint[])[idx]);
        }

        const tokenMetas: TokenMeta[] = await Promise.all(
          tokenAddresses.map(async (t) => {
            const cached = tokenMetaCache.get(t);
            if (cached) return cached;
            const meta = await readTokenMeta(publicClient, t);
            tokenMetaCache.set(t, meta);
            return meta;
          }),
        );

        const poolMeta: PoolMeta = {
          poolAddress: normalizeAddress(poolAddress),
          dex: "balancer",
          tokenAddresses,
        };

        await Promise.all([
          upsertPool(db, poolMeta),
          ...tokenMetas.map((m) => upsertToken(db, m)),
        ]);

        const tokenAmounts: Record<string, string> = {};
        for (const m of tokenMetas) {
          tokenAmounts[m.tokenAddress] = (balancesByToken.get(m.tokenAddress) ?? 0n).toString();
        }

        const poolSnap: PoolSnapshot = {
          timestamp: nowIso,
          dex: "balancer",
          poolAddress: normalizeAddress(poolAddress),
          tokenAmounts,
        };
        await upsertPoolSnapshot(db, poolSnap);

        const depthByTokenHuman: Record<string, string> = {};
        for (const m of tokenMetas) {
          const raw = balancesByToken.get(m.tokenAddress) ?? 0n;
          depthByTokenHuman[m.tokenAddress] = formatUnits(raw, m.decimals);
        }

        await Promise.all(
          bandList.map(async (bandBps) => {
            await Promise.all(
              tokenMetas.map(async (m) => {
                const snap: TokenDepthSnapshot = {
                  timestamp: nowIso,
                  dex: "balancer",
                  tokenAddress: m.tokenAddress,
                  bandBps,
                  depthSimple: depthByTokenHuman[m.tokenAddress],
                  depthBand: depthByTokenHuman[m.tokenAddress],
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

