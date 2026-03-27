import type { PoolSnapshot, TokenDepthSnapshot } from "@monmon/shared";
import { formatUnits } from "@monmon/shared";
import type { Pool } from "pg";
import { createPublicClient, decodeEventLog, keccak256, toBytes, toHex, zeroAddress } from "viem";
import type { Env } from "../config.js";
import { createMonadPublicClient } from "../monadPublicClient.js";

import { upsertPool, upsertToken } from "../repositories/catalog.js";
import {
  upsertPoolSnapshot,
  upsertPoolSwapDepthSnapshot,
  upsertTokenDepthSnapshot,
} from "../repositories/snapshots.js";
import type { TokenMeta, PoolMeta } from "../repositories/catalog.js";

/** Ethereum mainnet Balancer V2 vault (used when not on Monad V3). */
const BALANCER_VAULT_V2 = "0xba12222222228d8Ba445958a75a0704d566BF2C8";

/** Monad Balancer V3 (docs: Core Contracts → Vault / Router). */
const MONAD_BALANCER_V3_VAULT = "0xbA1333333333a1BA1108E8412f11850A5C319bA9";
const MONAD_BALANCER_V3_ROUTER = "0x9dA18982a33FD0c7051B19F0d7C76F2d5E7e017c";

/** Non-mock factories from Balancer “Monad contracts” list — `PoolCreated(address)`. */
const MONAD_BALANCER_V3_DEFAULT_FACTORIES = [
  "0x4bdCc2fb18AEb9e2d281b0278D946445070eAda7", // WeightedPoolFactory v2
  "0xf5CDdF6feD9C589f1Be04899F48f9738531daD59", // StablePoolFactory v3
  "0xDB8d758BCb971e482B2C45f7F8a7740283A1bd3A", // StableSurgePoolFactory
  "0x96484f2aBF5e58b15176dbF1A799627B53F13B6d", // ReClammPoolFactory
  "0xa3b370092aeb56770B23315252aB5E16DAcBF62B", // LBPoolFactory
  "0xF39CA6ede9BF7820a952b52f3c94af526bAB9015", // Gyro2CLPPoolFactory v2
  "0x4b979eD48F982Ba0baA946cB69c1083eB799729c", // GyroECLPPoolFactory v2
  "0xe2fa4e1d17725e72dcdAfe943Ecf45dF4b9E285b", // FixedPriceLBPoolFactory
];

const vaultV2Abi = [
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

const vaultQueryBatchSwapAbi = [
  {
    type: "function",
    name: "queryBatchSwap",
    stateMutability: "nonpayable",
    inputs: [
      { name: "kind", type: "uint8" },
      {
        name: "swaps",
        type: "tuple[]",
        components: [
          { name: "poolId", type: "bytes32" },
          { name: "assetInIndex", type: "uint256" },
          { name: "assetOutIndex", type: "uint256" },
          { name: "amount", type: "uint256" },
          { name: "userData", type: "bytes" },
        ],
      },
      { name: "assets", type: "address[]" },
      {
        name: "funds",
        type: "tuple",
        components: [
          { name: "sender", type: "address" },
          { name: "fromInternalBalance", type: "bool" },
          { name: "recipient", type: "address" },
          { name: "toInternalBalance", type: "bool" },
        ],
      },
    ],
    outputs: [{ name: "assetDeltas", type: "int256[]" }],
  },
] as const;

/** Balancer V3 `BasePoolFactory`: list all deployed pools without relying on log lookback. */
const factoryV3EnumerateAbi = [
  {
    type: "function",
    name: "getPoolCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "poolCount", type: "uint256" }],
  },
  {
    type: "function",
    name: "getPoolsInRange",
    stateMutability: "view",
    inputs: [
      { name: "start", type: "uint256" },
      { name: "count", type: "uint256" },
    ],
    outputs: [{ name: "pools", type: "address[]" }],
  },
] as const;

const FACTORY_POOL_PAGE = 40;

const vaultV3ReadAbi = [
  {
    type: "function",
    name: "isPoolInitialized",
    stateMutability: "view",
    inputs: [{ name: "pool", type: "address" }],
    outputs: [{ name: "initialized", type: "bool" }],
  },
  {
    type: "function",
    name: "getPoolTokenInfo",
    stateMutability: "view",
    inputs: [{ name: "pool", type: "address" }],
    outputs: [
      { name: "tokens", type: "address[]" },
      {
        name: "tokenInfo",
        type: "tuple[]",
        components: [
          { name: "tokenType", type: "uint8" },
          { name: "rateProvider", type: "address" },
          { name: "paysYieldFees", type: "bool" },
        ],
      },
      { name: "balancesRaw", type: "uint256[]" },
      { name: "lastBalancesLiveScaled18", type: "uint256[]" },
    ],
  },
] as const;

const routerV3QueryAbi = [
  {
    type: "function",
    name: "querySwapSingleTokenExactIn",
    stateMutability: "nonpayable",
    inputs: [
      { name: "pool", type: "address" },
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "exactAmountIn", type: "uint256" },
      { name: "sender", type: "address" },
      { name: "userData", type: "bytes" },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
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

const CHAIN_MONAD = 143;
const SWAP_KIND_GIVEN_IN = 0;

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

function parseFactoryAddresses(raw: string | undefined, defaults: string[]): string[] {
  if (raw === undefined || raw.trim() === "") return [...defaults];
  return raw
    .split(",")
    .map((s) => normalizeAddress(s.trim()))
    .filter((a) => /^0x[0-9a-f]{40}$/.test(a));
}

function balancerUseV3(env: Env): boolean {
  if (env.MONAD_CHAIN_ID === CHAIN_MONAD) return true;
  return false;
}

function balancerV3Vault(env: Env): string {
  const o = env.BALANCER_V3_VAULT?.trim();
  if (o && /^0x[0-9a-fA-F]{40}$/.test(o)) return normalizeAddress(o);
  return normalizeAddress(MONAD_BALANCER_V3_VAULT);
}

function balancerV3Router(env: Env): string {
  const o = env.BALANCER_V3_ROUTER?.trim();
  if (o && /^0x[0-9a-fA-F]{40}$/.test(o)) return normalizeAddress(o);
  return normalizeAddress(MONAD_BALANCER_V3_ROUTER);
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

function sortTwoTokenAddresses(a: string, b: string): [`0x${string}`, `0x${string}`] {
  const aa = a.toLowerCase();
  const bb = b.toLowerCase();
  return aa < bb ? [aa as `0x${string}`, bb as `0x${string}`] : [bb as `0x${string}`, aa as `0x${string}`];
}

function amountInRawForBand(balanceIn: bigint, bandBps: number): bigint {
  if (balanceIn === 0n) return 0n;
  const raw = (balanceIn * BigInt(bandBps)) / 10000n;
  if (raw === 0n) return 0n;
  return raw < balanceIn ? raw : balanceIn - 1n;
}

async function queryBalancerV2AmountOut(
  publicClient: ReturnType<typeof createPublicClient>,
  params: {
    poolId: `0x${string}`;
    tokenIn: string;
    tokenOut: string;
    amountInRaw: bigint;
  },
): Promise<bigint | null> {
  const { poolId, tokenIn, tokenOut, amountInRaw } = params;
  if (amountInRaw === 0n) return 0n;

  const tin = tokenIn.toLowerCase();
  const tout = tokenOut.toLowerCase();
  const [asset0, asset1] = sortTwoTokenAddresses(tin, tout);
  const assetInIndex = tin === asset0.toLowerCase() ? 0 : 1;
  const assetOutIndex = tout === asset0.toLowerCase() ? 0 : 1;

  const funds = {
    sender: zeroAddress,
    fromInternalBalance: false,
    recipient: zeroAddress,
    toInternalBalance: false,
  };

  try {
    const assetDeltas = (await publicClient.readContract({
      address: BALANCER_VAULT_V2 as `0x${string}`,
      abi: vaultQueryBatchSwapAbi,
      functionName: "queryBatchSwap",
      args: [
        SWAP_KIND_GIVEN_IN,
        [
          {
            poolId,
            assetInIndex: BigInt(assetInIndex),
            assetOutIndex: BigInt(assetOutIndex),
            amount: amountInRaw,
            userData: "0x",
          },
        ],
        [asset0, asset1],
        funds,
      ],
    })) as readonly bigint[];

    const dOut = assetDeltas[assetOutIndex];
    if (dOut === undefined) return null;
    return dOut < 0n ? -dOut : 0n;
  } catch {
    return null;
  }
}

async function queryBalancerV3AmountOut(
  publicClient: ReturnType<typeof createPublicClient>,
  params: {
    router: string;
    pool: string;
    tokenIn: string;
    tokenOut: string;
    amountInRaw: bigint;
  },
): Promise<bigint | null> {
  const { router, pool, tokenIn, tokenOut, amountInRaw } = params;
  if (amountInRaw === 0n) return 0n;
  try {
    return (await publicClient.readContract({
      address: router as `0x${string}`,
      abi: routerV3QueryAbi,
      functionName: "querySwapSingleTokenExactIn",
      args: [
        pool as `0x${string}`,
        tokenIn as `0x${string}`,
        tokenOut as `0x${string}`,
        amountInRaw,
        zeroAddress,
        "0x",
      ],
    })) as bigint;
  } catch {
    return null;
  }
}

export async function runBalancerDepthSnapshot(params: { env: Env; db: Pool; snapshotTs?: string }) {
  const { env, db, snapshotTs } = params;
  if (balancerUseV3(env)) {
    await runBalancerV3DepthSnapshot(params);
  } else {
    await runBalancerV2DepthSnapshot(params);
  }
}

async function runBalancerV3DepthSnapshot(params: { env: Env; db: Pool; snapshotTs?: string }) {
  const { env, db, snapshotTs } = params;
  const bandList = parseBandList(env.BAND_BPS_LIST);
  if (bandList.length === 0) throw new Error("BAND_BPS_LIST produced no valid bands");

  const vaultAddr = balancerV3Vault(env);
  const routerAddr = balancerV3Router(env);
  const factories = parseFactoryAddresses(env.BALANCER_V3_FACTORY_ADDRESSES, MONAD_BALANCER_V3_DEFAULT_FACTORIES);

  const publicClient = createMonadPublicClient(env);

  const pools = new Set<string>();
  for (const factory of factories) {
    if (pools.size >= env.DISCOVERY_MAX_POOLS) break;

    let poolCount: bigint;
    try {
      poolCount = (await publicClient.readContract({
        address: factory as `0x${string}`,
        abi: factoryV3EnumerateAbi,
        functionName: "getPoolCount",
      })) as bigint;
    } catch {
      console.warn(`balancer v3: getPoolCount failed, skipping factory ${factory}`);
      continue;
    }

    const n = Number(poolCount);
    if (!Number.isFinite(n) || n <= 0) continue;

    for (let start = 0; start < n; start += FACTORY_POOL_PAGE) {
      if (pools.size >= env.DISCOVERY_MAX_POOLS) break;

      const pageSize = Math.min(FACTORY_POOL_PAGE, n - start);
      let slice: readonly string[];
      try {
        slice = (await publicClient.readContract({
          address: factory as `0x${string}`,
          abi: factoryV3EnumerateAbi,
          functionName: "getPoolsInRange",
          args: [BigInt(start), BigInt(pageSize)],
        })) as readonly string[];
      } catch {
        console.warn(`balancer v3: getPoolsInRange failed ${factory} start=${start}`);
        break;
      }

      for (const p of slice) {
        pools.add(normalizeAddress(String(p)));
        if (pools.size >= env.DISCOVERY_MAX_POOLS) break;
      }
    }
  }

  console.log(`Balancer v3 discovered ${pools.size} pools (factories=${factories.length}, on-chain enumeration)`);

  const nowIso = snapshotTs ?? new Date().toISOString();
  const tokenMetaCache = new Map<string, TokenMeta>();
  const poolList = [...pools];

  for (let i = 0; i < poolList.length; i += env.SNAPSHOT_BATCH_SIZE) {
    const batch = poolList.slice(i, i + env.SNAPSHOT_BATCH_SIZE);
    await Promise.allSettled(
      batch.map(async (poolAddress) => {
        let initialized = false;
        try {
          initialized = await publicClient.readContract({
            address: vaultAddr as `0x${string}`,
            abi: vaultV3ReadAbi,
            functionName: "isPoolInitialized",
            args: [poolAddress as `0x${string}`],
          });
        } catch {
          return;
        }
        if (!initialized) return;

        let tokens: string[];
        let balancesRaw: readonly bigint[];
        try {
          const r = await publicClient.readContract({
            address: vaultAddr as `0x${string}`,
            abi: vaultV3ReadAbi,
            functionName: "getPoolTokenInfo",
            args: [poolAddress as `0x${string}`],
          });
          const tuple = r as [string[], unknown, readonly bigint[], readonly bigint[]];
          tokens = tuple[0].map((t) => normalizeAddress(String(t)));
          balancesRaw = tuple[2];
        } catch {
          return;
        }

        const tokenAddresses = tokens.filter((t) => t !== "0x0000000000000000000000000000000000000000");
        if (tokenAddresses.length !== 2) return;

        const balancesByToken = new Map<string, bigint>();
        for (let idx = 0; idx < tokenAddresses.length; idx++) {
          balancesByToken.set(tokenAddresses[idx]!, balancesRaw[idx] ?? 0n);
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

        await upsertPoolSnapshot(db, {
          timestamp: nowIso,
          dex: "balancer",
          poolAddress: normalizeAddress(poolAddress),
          tokenAmounts,
        });

        const depthByTokenHuman: Record<string, string> = {};
        for (const m of tokenMetas) {
          const raw = balancesByToken.get(m.tokenAddress) ?? 0n;
          depthByTokenHuman[m.tokenAddress] = formatUnits(raw, m.decimals);
        }

        await Promise.all(
          bandList.flatMap((bandBps) =>
            tokenMetas.map((m) =>
              upsertTokenDepthSnapshot(db, {
                timestamp: nowIso,
                dex: "balancer",
                tokenAddress: m.tokenAddress,
                bandBps,
                depthSimple: depthByTokenHuman[m.tokenAddress]!,
                depthBand: depthByTokenHuman[m.tokenAddress]!,
              }),
            ),
          ),
        );

        const depthSimpleBps = env.DEPTH_SIMPLE_BAND_BPS;
        const [m0, m1] =
          tokenMetas[0]!.tokenAddress < tokenMetas[1]!.tokenAddress
            ? [tokenMetas[0]!, tokenMetas[1]!]
            : [tokenMetas[1]!, tokenMetas[0]!];

        const swapRows: Array<ReturnType<typeof upsertPoolSwapDepthSnapshot>> = [];
        for (const [src, dst] of [
          [m0, m1] as const,
          [m1, m0] as const,
        ]) {
          const balIn = balancesByToken.get(src.tokenAddress) ?? 0n;
          const amountSimpleIn = amountInRawForBand(balIn, depthSimpleBps);
          const outSimpleRaw = await queryBalancerV3AmountOut(publicClient, {
            router: routerAddr,
            pool: poolAddress,
            tokenIn: src.tokenAddress,
            tokenOut: dst.tokenAddress,
            amountInRaw: amountSimpleIn,
          });
          if (outSimpleRaw === null) continue;
          const depthSimpleStr = formatUnits(outSimpleRaw, dst.decimals);

          for (const bandBps of bandList) {
            const amountBandIn = amountInRawForBand(balIn, bandBps);
            const outBandRaw = await queryBalancerV3AmountOut(publicClient, {
              router: routerAddr,
              pool: poolAddress,
              tokenIn: src.tokenAddress,
              tokenOut: dst.tokenAddress,
              amountInRaw: amountBandIn,
            });
            if (outBandRaw === null) continue;
            const depthBandStr = formatUnits(outBandRaw, dst.decimals);

            swapRows.push(
              upsertPoolSwapDepthSnapshot(db, {
                timestamp: nowIso,
                dex: "balancer",
                poolAddress: normalizeAddress(poolAddress),
                bandBps,
                tokenIn: src.tokenAddress,
                tokenOut: dst.tokenAddress,
                depthSimple: depthSimpleStr,
                depthBand: depthBandStr,
              }),
            );
          }
        }

        await Promise.all(swapRows);
      }),
    );
  }
}

async function runBalancerV2DepthSnapshot(params: { env: Env; db: Pool; snapshotTs?: string }) {
  const { env, db, snapshotTs } = params;
  const bandList = parseBandList(env.BAND_BPS_LIST);
  if (bandList.length === 0) throw new Error("BAND_BPS_LIST produced no valid bands");

  const publicClient = createMonadPublicClient(env);

  const latestBlock = await publicClient.getBlockNumber();
  const lookback = BigInt(env.DISCOVERY_LOOKBACK_BLOCKS);
  const fromBlock = latestBlock > lookback ? latestBlock - lookback : 0n;
  const toBlock = latestBlock;

  const poolRegisteredTopic0 = keccak256(toBytes("PoolRegistered(bytes32,address,uint8)"));
  const MAX_LOG_BLOCK_RANGE = 1_000n;
  const logs: Array<{ data: string; topics: string[] }> = [];
  for (let start = fromBlock; start <= toBlock; start += MAX_LOG_BLOCK_RANGE) {
    const end = start + MAX_LOG_BLOCK_RANGE - 1n > toBlock ? toBlock : start + MAX_LOG_BLOCK_RANGE - 1n;
    const chunkLogs = (await publicClient.request({
      method: "eth_getLogs",
      params: [
        {
          address: BALANCER_VAULT_V2,
          fromBlock: toHex(start),
          toBlock: toHex(end),
          topics: [poolRegisteredTopic0],
        },
      ],
    })) as Array<{ data: string; topics: string[] }>;
    logs.push(...chunkLogs);
  }

  const pools = new Map<string, { poolId: string; poolAddress: string; specialization: number }>();
  for (const log of logs) {
    const decoded = decodeEventLog({
      abi: vaultV2Abi,
      eventName: "PoolRegistered",
      data: log.data as `0x${string}`,
      topics: log.topics as unknown as [`0x${string}`, ...`0x${string}`[]],
    });
    const poolId = String(decoded.args.poolId).toLowerCase();
    const poolAddress = normalizeAddress(String(decoded.args.poolAddress));
    const specialization = Number(decoded.args.specialization);
    if (specialization !== 2) continue;
    pools.set(poolId, { poolId, poolAddress, specialization });
    if (pools.size >= env.DISCOVERY_MAX_POOLS) break;
  }

  console.log(`Balancer v2 discovered ${pools.size} pools`);

  const nowIso = snapshotTs ?? new Date().toISOString();
  const tokenMetaCache = new Map<string, TokenMeta>();
  const poolList = Array.from(pools.values());

  for (let i = 0; i < poolList.length; i += env.SNAPSHOT_BATCH_SIZE) {
    const batch = poolList.slice(i, i + env.SNAPSHOT_BATCH_SIZE);
    await Promise.allSettled(
      batch.map(async ({ poolId, poolAddress }) => {
        const [tokens, balances] = (await publicClient.readContract({
          address: BALANCER_VAULT_V2 as `0x${string}`,
          abi: vaultV2Abi,
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

        await upsertPoolSnapshot(db, {
          timestamp: nowIso,
          dex: "balancer",
          poolAddress: normalizeAddress(poolAddress),
          tokenAmounts,
        });

        const depthByTokenHuman: Record<string, string> = {};
        for (const m of tokenMetas) {
          const raw = balancesByToken.get(m.tokenAddress) ?? 0n;
          depthByTokenHuman[m.tokenAddress] = formatUnits(raw, m.decimals);
        }

        await Promise.all(
          bandList.flatMap((bandBps) =>
            tokenMetas.map((m) =>
              upsertTokenDepthSnapshot(db, {
                timestamp: nowIso,
                dex: "balancer",
                tokenAddress: m.tokenAddress,
                bandBps,
                depthSimple: depthByTokenHuman[m.tokenAddress]!,
                depthBand: depthByTokenHuman[m.tokenAddress]!,
              }),
            ),
          ),
        );

        if (tokenMetas.length !== 2) return;

        const depthSimpleBps = env.DEPTH_SIMPLE_BAND_BPS;
        const [m0, m1] =
          tokenMetas[0]!.tokenAddress < tokenMetas[1]!.tokenAddress
            ? [tokenMetas[0]!, tokenMetas[1]!]
            : [tokenMetas[1]!, tokenMetas[0]!];
        const poolIdHex = (poolId.startsWith("0x") ? poolId : `0x${poolId}`) as `0x${string}`;

        const swapRows: Array<ReturnType<typeof upsertPoolSwapDepthSnapshot>> = [];
        for (const [src, dst] of [
          [m0, m1] as const,
          [m1, m0] as const,
        ]) {
          const balIn = balancesByToken.get(src.tokenAddress) ?? 0n;
          const amountSimpleIn = amountInRawForBand(balIn, depthSimpleBps);
          const outSimpleRaw = await queryBalancerV2AmountOut(publicClient, {
            poolId: poolIdHex,
            tokenIn: src.tokenAddress,
            tokenOut: dst.tokenAddress,
            amountInRaw: amountSimpleIn,
          });
          if (outSimpleRaw === null) continue;
          const depthSimpleStr = formatUnits(outSimpleRaw, dst.decimals);

          for (const bandBps of bandList) {
            const amountBandIn = amountInRawForBand(balIn, bandBps);
            const outBandRaw = await queryBalancerV2AmountOut(publicClient, {
              poolId: poolIdHex,
              tokenIn: src.tokenAddress,
              tokenOut: dst.tokenAddress,
              amountInRaw: amountBandIn,
            });
            if (outBandRaw === null) continue;
            const depthBandStr = formatUnits(outBandRaw, dst.decimals);

            swapRows.push(
              upsertPoolSwapDepthSnapshot(db, {
                timestamp: nowIso,
                dex: "balancer",
                poolAddress: normalizeAddress(poolAddress),
                bandBps,
                tokenIn: src.tokenAddress,
                tokenOut: dst.tokenAddress,
                depthSimple: depthSimpleStr,
                depthBand: depthBandStr,
              }),
            );
          }
        }

        await Promise.all(swapRows);
      }),
    );
  }
}
