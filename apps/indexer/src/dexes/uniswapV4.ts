import type { Pool } from "pg";
import type { Env } from "../config.js";

import {
  createPublicClient,
  decodeEventLog,
  defineChain,
  http,
  keccak256,
  toBytes,
} from "viem";
import { formatUnits, uniswapV3DirectionalMaxOutputRaw } from "@monmon/shared";
import { upsertPool, upsertToken, type PoolMeta, type TokenMeta } from "../repositories/catalog.js";
import { upsertPoolSwapDepthSnapshot } from "../repositories/snapshots.js";

// MVP adapter:
// - We snapshot Uniswap v4 pools you specify via poolIds (PoC only).
// - We compute directional max output within the ±band using active liquidity from StateView
//   and the same sqrt-bound formulas as the v3 constant-liquidity metric.
// - To label token0/token1 we decode PoolManager's Initialize event for the poolId.

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

const normalizeAddress = (addr: string) => addr.toLowerCase();

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

function isNativeCurrency(addr: string) {
  return normalizeAddress(addr) === "0x0000000000000000000000000000000000000000";
}

async function readTokenMeta(publicClient: ReturnType<typeof createPublicClient>, tokenAddress: string): Promise<TokenMeta> {
  const addr = normalizeAddress(tokenAddress);
  if (isNativeCurrency(addr)) {
    // For Monad native MON, we surface it as MON with 18 decimals.
    // (If you later want WMON instead, we can map here.)
    return { tokenAddress: addr, symbol: "MON", decimals: 18 };
  }

  const [decimals, symbol] = await Promise.all([
    publicClient.readContract({ address: addr as `0x${string}`, abi: erc20Abi, functionName: "decimals" }),
    publicClient.readContract({ address: addr as `0x${string}`, abi: erc20Abi, functionName: "symbol" }),
  ]);

  return { tokenAddress: addr, symbol: String(symbol), decimals: Number(decimals) };
}

const POOL_MANAGER_INIT_EVENT_SIG = "Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)";
const POOL_MANAGER_INIT_TOPIC0 = keccak256(toBytes(POOL_MANAGER_INIT_EVENT_SIG));

const poolManagerInitializeAbi = [
  {
    type: "event",
    name: "Initialize",
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "currency0", type: "address", indexed: true },
      { name: "currency1", type: "address", indexed: true },
      { name: "fee", type: "uint24", indexed: false },
      { name: "tickSpacing", type: "int24", indexed: false },
      { name: "hooks", type: "address", indexed: false },
      { name: "sqrtPriceX96", type: "uint160", indexed: false },
      { name: "tick", type: "int24", indexed: false },
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

function parseBandList(bands: string): number[] {
  return bands
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n > 0 && n < 20000);
}

async function findV4PoolCurrenciesFromInitialize(params: {
  publicClient: ReturnType<typeof createPublicClient>;
  poolManager: string;
  poolId: string;
  fromBlock: bigint;
  toBlock: bigint;
  maxLogBlockRange: bigint;
}): Promise<{ currency0: string; currency1: string }> {
  const { publicClient, poolManager, poolId, fromBlock, toBlock, maxLogBlockRange } = params;

  for (let start = fromBlock; start <= toBlock; start += maxLogBlockRange) {
    const end = start + maxLogBlockRange - 1n > toBlock ? toBlock : start + maxLogBlockRange - 1n;
    const logs = (await publicClient.request({
      method: "eth_getLogs",
      params: [
        {
          address: poolManager as `0x${string}`,
          fromBlock: `0x${start.toString(16)}`,
          toBlock: `0x${end.toString(16)}`,
          topics: [POOL_MANAGER_INIT_TOPIC0, poolId as `0x${string}`],
        },
      ],
    })) as Array<{ data: string; topics: string[] }>;

    if (logs.length === 0) continue;

    // We only care about currency0/currency1 for token labeling + decimals.
    const decoded = decodeEventLog({
      abi: poolManagerInitializeAbi,
      eventName: "Initialize",
      data: logs[0].data as `0x${string}`,
      topics: logs[0].topics as unknown as [`0x${string}`, ...`0x${string}`[]],
    });

    const currency0 = normalizeAddress(String((decoded as any).args.currency0));
    const currency1 = normalizeAddress(String((decoded as any).args.currency1));
    return { currency0, currency1 };
  }

  throw new Error(`uniswap_v4: could not find Initialize log for poolId=${poolId}`);
}

export async function runUniswapV4DepthSnapshot(params: { env: Env; db: Pool }) {
  const { env, db } = params;

  const poolIds = parsePoolIds(env.UNISWAP_V4_POOL_IDS);
  if (poolIds.length === 0) return;

  if (!env.UNISWAP_V4_POOL_MANAGER || !env.UNISWAP_V4_STATE_VIEW) {
    throw new Error("UNISWAP_V4_POOL_MANAGER and UNISWAP_V4_STATE_VIEW are required for uniswap_v4 snapshots");
  }

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
  const maxLogBlockRange = 1_000n;

  const bandList = parseBandList(env.BAND_BPS_LIST);
  if (bandList.length === 0) return;

  const nowIso = new Date().toISOString();
  const depthSimpleBps = env.DEPTH_SIMPLE_BAND_BPS;

  for (const poolId of poolIds) {
    const { currency0, currency1 } = await findV4PoolCurrenciesFromInitialize({
      publicClient,
      poolManager: env.UNISWAP_V4_POOL_MANAGER,
      poolId,
      fromBlock,
      toBlock,
      maxLogBlockRange,
    });

    const [token0Meta, token1Meta] = await Promise.all([
      readTokenMeta(publicClient, currency0),
      readTokenMeta(publicClient, currency1),
    ]);

    const [slot0, liquidity] = await Promise.all([
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
      // token0 -> token1 exact input (zeroForOne = true in v4 terms).
      const outToken0To1Raw = uniswapV3DirectionalMaxOutputRaw({
        liquidity: liquidityBigInt,
        sqrtPriceX96,
        bandBps,
        direction: "token0to1",
      });

      // token1 -> token0 exact input.
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

