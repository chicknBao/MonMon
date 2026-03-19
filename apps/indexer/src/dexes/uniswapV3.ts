import type { PoolSnapshot, TokenDepthSnapshot } from "@monmon/shared";
import {
  uniswapV3BandAmountsRaw,
  uniswapV3DirectionalMaxOutputRaw,
  integerSqrt,
  formatUnits,
  getSqrtRatioAtTickX96,
} from "@monmon/shared";
import type { Pool } from "pg";
import {
  createPublicClient,
  decodeEventLog,
  http,
  toBytes,
  toHex,
  keccak256,
  defineChain,
  encodeAbiParameters,
  getCreate2Address,
} from "viem";

import { upsertPool, upsertToken, type PoolMeta, type TokenMeta } from "../repositories/catalog.js";
import {
  upsertPoolSnapshot,
  upsertTokenDepthSnapshot,
  upsertPoolSwapDepthSnapshot,
} from "../repositories/snapshots.js";
import type { Env } from "../config.js";

const UNISWAP_V3_FACTORY = "0x204faca1764b154221e35c0d20abb3c525710498";

const uniswapV3FactoryAbi = [
  {
    type: "event",
    name: "PoolCreated",
    inputs: [
      { name: "token0", type: "address", indexed: true },
      { name: "token1", type: "address", indexed: true },
      { name: "fee", type: "uint24", indexed: true },
      { name: "tickSpacing", type: "int24", indexed: false },
      { name: "pool", type: "address", indexed: false },
    ],
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
  {
    type: "function",
    name: "tickSpacing",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "int24" }],
  },
  {
    type: "function",
    name: "ticks",
    stateMutability: "view",
    inputs: [{ name: "tick", type: "int24" }],
    outputs: [
      { name: "liquidityGross", type: "uint128" },
      { name: "liquidityNet", type: "int128" },
      { name: "feeGrowthOutside0X128", type: "uint256" },
      { name: "feeGrowthOutside1X128", type: "uint256" },
      { name: "tickCumulativeOutside", type: "int56" },
      { name: "secondsPerLiquidityOutsideX128", type: "uint160" },
      { name: "secondsOutside", type: "uint32" },
      { name: "initialized", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "tickBitmap",
    stateMutability: "view",
    inputs: [{ name: "wordPosition", type: "int16" }],
    outputs: [{ name: "", type: "uint256" }],
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

const Q192 = 2n ** 192n;
const Q96 = 2n ** 96n;
const SCALE_1E18 = 10n ** 18n;

// Canonical Uniswap v3 pool init code hash used for CREATE2 pool address computation.
// Uniswap docs: https://docs.uniswap.org/contracts/v3/reference/periphery/test/PoolAddressTest
const UNISWAP_V3_POOL_INIT_CODE_HASH =
  "0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54";

const STABLE_TOKENS_USD_1: Record<
  string,
  { symbol: string; decimals: number }
> = {
  // Common USD stables on Monad (addresses sourced from onchain references / deployed contracts).
  "0x754704bc059f8c67012fed69bc8a327a5aafb603": { symbol: "USDC", decimals: 6 },
  "0xe7cd86e13ac4309349f30b3435a9d337750fc82d": { symbol: "USDT", decimals: 6 },
  "0x00000000efe302beaa2b3e6e1b18d08d69a9012a": { symbol: "AUSD", decimals: 18 },
};

/** Wrapped MON — used as PoC $1 quote when no stable leg exists. */
const WMON = "0x3bd359c1119da7da1d913d1c4d2b7c461115433a";

function isWmon(addr: string) {
  return normalizeAddress(addr) === WMON;
}

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

function toInt16(x: bigint): number {
  // Convert bigint to signed int16 (two's complement) without relying on JS number overflow.
  let v = x & ((1n << 16n) - 1n);
  if (v >= (1n << 15n)) v -= 1n << 16n;
  return Number(v);
}

function divFloorInt(a: bigint, b: bigint): bigint {
  // Solidity's `int / positiveInt` truncates toward zero; for negatives we need floor.
  let q = a / b;
  const r = a % b;
  if (r !== 0n && a < 0n) q -= 1n;
  return q;
}

function msbIndex(x: bigint): number {
  if (x <= 0n) throw new Error("msbIndex: x must be > 0");
  let r = 0;
  if (x >= 1n << 128n) {
    x >>= 128n;
    r += 128;
  }
  if (x >= 1n << 64n) {
    x >>= 64n;
    r += 64;
  }
  if (x >= 1n << 32n) {
    x >>= 32n;
    r += 32;
  }
  if (x >= 1n << 16n) {
    x >>= 16n;
    r += 16;
  }
  if (x >= 1n << 8n) {
    x >>= 8n;
    r += 8;
  }
  if (x >= 1n << 4n) {
    x >>= 4n;
    r += 4;
  }
  if (x >= 1n << 2n) {
    x >>= 2n;
    r += 2;
  }
  if (x >= 1n << 1n) {
    r += 1;
  }
  return r;
}

function lsbIndex(x: bigint): number {
  if (x <= 0n) throw new Error("lsbIndex: x must be > 0");
  // count trailing zeros via progressively checking lower chunks
  let r = 0;
  const MASK_128 = (1n << 128n) - 1n;
  const MASK_64 = (1n << 64n) - 1n;
  const MASK_32 = (1n << 32n) - 1n;
  const MASK_16 = (1n << 16n) - 1n;
  const MASK_8 = (1n << 8n) - 1n;
  const MASK_4 = (1n << 4n) - 1n;
  const MASK_2 = (1n << 2n) - 1n;
  const MASK_1 = 1n;

  if ((x & MASK_128) === 0n) {
    x >>= 128n;
    r += 128;
  }
  if ((x & MASK_64) === 0n) {
    x >>= 64n;
    r += 64;
  }
  if ((x & MASK_32) === 0n) {
    x >>= 32n;
    r += 32;
  }
  if ((x & MASK_16) === 0n) {
    x >>= 16n;
    r += 16;
  }
  if ((x & MASK_8) === 0n) {
    x >>= 8n;
    r += 8;
  }
  if ((x & MASK_4) === 0n) {
    x >>= 4n;
    r += 4;
  }
  if ((x & MASK_2) === 0n) {
    x >>= 2n;
    r += 2;
  }
  if ((x & MASK_1) === 0n) r += 1;
  return r;
}

async function uniswapV3DirectionalMaxOutputTickWalkForBands(params: {
  publicClient: ReturnType<typeof createPublicClient>;
  poolAddress: string;
  tickSpacing: number;
  tickCurrent: number;
  liquidity: bigint;
  sqrtPriceX96: bigint;
  bandBpsList: number[];
  direction: "token0to1" | "token1to0";
  maxSteps?: number;
}): Promise<Record<number, bigint>> {
  const {
    publicClient,
    poolAddress,
    tickSpacing,
    tickCurrent,
    liquidity,
    sqrtPriceX96,
    bandBpsList,
    direction,
    maxSteps = 250,
  } = params;

  const Q96Local = Q96;
  const denom = 10000n;
  const bandToTargetSqrt: Array<{ bandBps: number; targetSqrtX96: bigint }> = bandBpsList.map(
    (bandBps) => {
      const band = BigInt(bandBps);
      const sqrtPrice2 = sqrtPriceX96 * sqrtPriceX96; // Q192 scaled
      const sqrtLowerX96 = integerSqrt((sqrtPrice2 * (denom - band)) / denom);
      const sqrtUpperX96 = integerSqrt((sqrtPrice2 * (denom + band)) / denom);

      const targetSqrtX96 = direction === "token0to1" ? sqrtLowerX96 : sqrtUpperX96;
      return { bandBps, targetSqrtX96 };
    },
  );

  // Traverse from the closest target first (so we can store cumulative output at each band).
  const sortedTargets =
    direction === "token0to1"
      ? bandToTargetSqrt.sort((a, b) => (a.targetSqrtX96 > b.targetSqrtX96 ? -1 : 1))
      : bandToTargetSqrt.sort((a, b) => (a.targetSqrtX96 < b.targetSqrtX96 ? -1 : 1));

  const outputs: Record<number, bigint> = {};

  let sqrtStart = sqrtPriceX96;
  let tick = tickCurrent;
  let L = liquidity;
  let amountOut = 0n;
  let idx = 0;
  let steps = 0;

  const UINT256_MAX = (1n << 256n) - 1n;
  const bitmapWordCache = new Map<number, bigint>();

  async function readTickBitmapWord(wordPos: number): Promise<bigint> {
    const cached = bitmapWordCache.get(wordPos);
    if (cached !== undefined) return cached;
    const word = await publicClient.readContract({
      address: poolAddress as `0x${string}`,
      abi: uniswapV3PoolAbi,
      functionName: "tickBitmap",
      args: [wordPos],
    });
    const asBig = BigInt(word as unknown as bigint);
    bitmapWordCache.set(wordPos, asBig);
    return asBig;
  }

  function nextInitializedTickWithinOneWord(currentTick: number, lte: boolean): Promise<{
    tickNext: number;
    initialized: boolean;
  }> {
    const tickBig = BigInt(currentTick);
    const spacingBig = BigInt(tickSpacing);
    const compressed = divFloorInt(tickBig, spacingBig); // floor(tick / tickSpacing)

    if (lte) {
      const wordPos = toInt16(compressed >> 8n);
      const bitPosBig = ((compressed % 256n) + 256n) % 256n;
      const bitPos = Number(bitPosBig); // 0..255
      return (async () => {
        const word = await readTickBitmapWord(wordPos);
        const mask = (1n << BigInt(bitPos + 1)) - 1n;
        const masked = word & mask;
        const initialized = masked !== 0n;
        const msb = initialized ? msbIndex(masked) : 0;
        const nextCompressed = initialized
          ? compressed - BigInt(bitPos - msb)
          : compressed - BigInt(bitPos);
        return { tickNext: Number(nextCompressed * spacingBig), initialized };
      })();
    }

    // lte=false: search to the right (>= tick)
    const compressedP1 = compressed + 1n;
    const wordPos = toInt16(compressedP1 >> 8n);
    const bitPosBig = ((compressedP1 % 256n) + 256n) % 256n;
    const bitPos = Number(bitPosBig);

    return (async () => {
      const word = await readTickBitmapWord(wordPos);
      const maskLower = bitPos === 0 ? 0n : (1n << BigInt(bitPos)) - 1n;
      const mask = UINT256_MAX ^ maskLower; // ~((1<<bitPos)-1) in uint256 terms
      const masked = word & mask;
      const initialized = masked !== 0n;
      const lsb = initialized ? lsbIndex(masked) : 0;
      const nextCompressed = initialized
        ? compressedP1 + BigInt(lsb - bitPos)
        : compressedP1 + BigInt(255 - bitPos);
      return { tickNext: Number(nextCompressed * spacingBig), initialized };
    })();
  }

  while (
    idx < sortedTargets.length &&
    L > 0n &&
    (direction === "token0to1" ? sqrtStart > sortedTargets[idx].targetSqrtX96 : sqrtStart < sortedTargets[idx].targetSqrtX96) &&
    amountOut >= 0n
  ) {
    steps++;
    if (steps > maxSteps) break;
    if (sortedTargets[idx].targetSqrtX96 === sqrtStart) {
      outputs[sortedTargets[idx].bandBps] = amountOut;
      idx++;
      continue;
    }

    const lte = direction === "token0to1"; // moving leftward
    const { tickNext, initialized } = await nextInitializedTickWithinOneWord(tick, lte);
    const sqrtTickNextX96 = getSqrtRatioAtTickX96(tickNext);

    const targetSqrt = sortedTargets[idx].targetSqrtX96;

    const sqrtEnd =
      direction === "token0to1"
        ? sqrtTickNextX96 > targetSqrt
          ? sqrtTickNextX96
          : targetSqrt
        : sqrtTickNextX96 < targetSqrt
          ? sqrtTickNextX96
          : targetSqrt;

    if (sqrtEnd === sqrtStart) {
      // Prevent infinite loops due to integer rounding at tick boundaries.
      break;
    }

    if (direction === "token0to1") {
      // Exact token0->token1: amount1 = L * (sqrtStart - sqrtEnd) / Q96
      amountOut += (L * (sqrtStart - sqrtEnd)) / Q96Local;
    } else {
      // Exact token1->token0: amount0 = L * (sqrtEnd - sqrtStart) * Q96 / (sqrtEnd * sqrtStart)
      amountOut += (L * (sqrtEnd - sqrtStart) * Q96Local) / (sqrtEnd * sqrtStart);
    }

    sqrtStart = sqrtEnd;

    if (sqrtStart === targetSqrt) {
      outputs[sortedTargets[idx].bandBps] = amountOut;
      idx++;
      continue;
    }

    // We must have landed on tickNext's sqrt boundary; update liquidity if initialized.
    if (initialized) {
      const tickInfo = await publicClient.readContract({
        address: poolAddress as `0x${string}`,
        abi: uniswapV3PoolAbi,
        functionName: "ticks",
        args: [tickNext],
      });

      const liquidityNet = BigInt((tickInfo as any).liquidityNet ?? tickInfo[1]);
      let delta = liquidityNet;
      if (direction === "token0to1") delta = -delta; // pool.swap inverts for zeroForOne

      if (delta >= 0n) {
        L += delta;
      } else {
        const abs = -delta;
        L = abs >= L ? 0n : L - abs;
      }
    }

    // pool.swap: state.tick = zeroForOne ? step.tickNext - 1 : step.tickNext
    tick = direction === "token0to1" ? tickNext - 1 : tickNext;

    // Continue walking; stepCount is the cap.
  }

  // Fill any remaining bands with the latest accumulated output.
  for (const t of sortedTargets.slice(idx)) {
    outputs[t.bandBps] = amountOut;
  }

  return outputs;
}

function formatScaledUsd18ToPostgres(valueScaled18: bigint): string {
  const neg = valueScaled18 < 0n;
  const abs = neg ? -valueScaled18 : valueScaled18;
  const whole = abs / SCALE_1E18;
  const frac = abs % SCALE_1E18;
  if (frac === 0n) return `${neg ? "-" : ""}${whole.toString()}`;
  const fracStr = frac.toString().padStart(18, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole.toString()}.${fracStr}`;
}

function uniswapV3SpotPriceToken1PerToken0Scaled18(params: {
  sqrtPriceX96: bigint;
  token0Decimals: number;
  token1Decimals: number;
}): bigint {
  const { sqrtPriceX96, token0Decimals, token1Decimals } = params;
  // spot = (sqrtPriceX96^2 / 2^192) * 10^(dec0-dec1)
  let priceScaled = (sqrtPriceX96 * sqrtPriceX96 * SCALE_1E18) / Q192;
  const decDiff = token0Decimals - token1Decimals;
  if (decDiff >= 0) {
    priceScaled = priceScaled * 10n ** BigInt(decDiff);
  } else {
    priceScaled = priceScaled / 10n ** BigInt(-decDiff);
  }
  return priceScaled;
}

async function readTokenMeta(publicClient: ReturnType<typeof createPublicClient>, tokenAddress: string) {
  const addr = normalizeAddress(tokenAddress);
  const stable = STABLE_TOKENS_USD_1[addr];
  if (stable) return { tokenAddress: addr, symbol: stable.symbol, decimals: stable.decimals } satisfies TokenMeta;

  const [decimals, symbol] = await Promise.all([
    publicClient.readContract({ address: addr as `0x${string}`, abi: erc20Abi, functionName: "decimals" }),
    publicClient.readContract({ address: addr as `0x${string}`, abi: erc20Abi, functionName: "symbol" }),
  ]);

  return { tokenAddress: addr, symbol: String(symbol), decimals: Number(decimals) } satisfies TokenMeta;
}

function computeTokenUsdPriceScaled18(params: {
  stableToken?: TokenMeta;
  otherToken: TokenMeta;
  sqrtPriceX96: bigint;
}): bigint | undefined {
  const { stableToken, otherToken, sqrtPriceX96 } = params;
  if (!stableToken) return undefined;

  // If stableToken is token0: token1 price = spot(token1 per token0)
  // If stableToken is token1: token0 price = 1 / spot(token1 per token0)
  // We handle both cases at the caller because we know token0/token1 ordering.
  void otherToken;
  void sqrtPriceX96;
  return undefined;
}

export async function runUniswapV3DepthSnapshot(params: { env: Env; db: Pool }) {
  const { env, db } = params;

  const bandList = parseBandList(env.BAND_BPS_LIST);
  if (bandList.length === 0) {
    throw new Error("BAND_BPS_LIST produced no valid bands");
  }
  const depthSimpleBandBps = env.DEPTH_SIMPLE_BAND_BPS;

  const monadChain = defineChain({
    id: env.MONAD_CHAIN_ID,
    name: "Monad",
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: {
      default: { http: [env.MONAD_RPC_URL] },
    },
  });

  const publicClient = createPublicClient({
    chain: monadChain,
    transport: http(env.MONAD_RPC_URL),
  });

  const latestBlock = await publicClient.getBlockNumber();
  const lookback = BigInt(env.DISCOVERY_LOOKBACK_BLOCKS);
  const fromBlock = latestBlock > lookback ? latestBlock - lookback : 0n;
  const toBlock = latestBlock;

  const poolCreatedTopic0 = keccak256(
    toBytes("PoolCreated(address,address,uint24,int24,address)"),
  );

  // Some Monad free-tier RPC providers reject large `eth_getLogs` ranges
  // ("ranges over 10000 blocks are not supported on freetier").
  const MAX_LOG_BLOCK_RANGE = 1_000n;
  const logs: Array<{ data: string; topics: string[] }> = [];
  for (let start = fromBlock; start <= toBlock; start += MAX_LOG_BLOCK_RANGE) {
    const end = start + MAX_LOG_BLOCK_RANGE - 1n > toBlock ? toBlock : start + MAX_LOG_BLOCK_RANGE - 1n;
    const chunkLogs = (await publicClient.request({
      method: "eth_getLogs",
      params: [
        {
          address: UNISWAP_V3_FACTORY,
          fromBlock: toHex(start),
          toBlock: toHex(end),
          topics: [poolCreatedTopic0],
        },
      ],
    })) as Array<{ data: string; topics: string[] }>;
    logs.push(...chunkLogs);
  }

  const pools = new Map<string, { poolAddress: string; token0: string; token1: string }>();
  for (const log of logs) {
    const decoded = decodeEventLog({
      abi: uniswapV3FactoryAbi,
      eventName: "PoolCreated",
      data: log.data as `0x${string}`,
      topics: log.topics as unknown as [`0x${string}`, ...`0x${string}`[]],
    });
    const poolAddress = normalizeAddress(String(decoded.args.pool));
    const token0 = normalizeAddress(String(decoded.args.token0));
    const token1 = normalizeAddress(String(decoded.args.token1));
    pools.set(poolAddress, { poolAddress, token0, token1 });
    if (pools.size >= env.DISCOVERY_MAX_POOLS) break;
  }

  // Always try WMON / major quote pools (often missed if created outside lookback window).
  // Seed pools deterministically via Uniswap v3 CREATE2, so we don't need `factory.getPool()` eth_call
  // (your free-tier RPC rejects those).
  const quoteTokens = [
    "0x754704bc059f8c67012fed69bc8a327a5aafb603", // USDC
    "0x00000000efe302beaa2b3e6e1b18d08d69a9012a", // AUSD
  ];
  const feeTiers = [100, 500, 3000, 10000] as const;
  for (const other of quoteTokens) {
    const t0 = WMON < other ? WMON : other;
    const t1 = WMON < other ? other : WMON;
    for (const fee of feeTiers) {
      if (pools.size >= env.DISCOVERY_MAX_POOLS) break;
      const salt = keccak256(
        encodeAbiParameters(
          [{ type: "address" }, { type: "address" }, { type: "uint24" }],
          [t0 as `0x${string}`, t1 as `0x${string}`, fee],
        ),
      );
      const predictedPoolAddress = getCreate2Address({
        from: UNISWAP_V3_FACTORY as `0x${string}`,
        salt,
        bytecodeHash: UNISWAP_V3_POOL_INIT_CODE_HASH as `0x${string}`,
      });
      const p = normalizeAddress(String(predictedPoolAddress));
      if (p === "0x0000000000000000000000000000000000000000" || pools.has(p)) continue;

      // Only keep pools that are actually deployed; otherwise pool state calls will revert.
      const code = await publicClient.getCode({ address: predictedPoolAddress as `0x${string}` });
      if (!code || code === "0x") continue;

      pools.set(p, { poolAddress: p, token0: t0, token1: t1 });
    }
  }

  console.log(`Uniswap v3 discovered ${pools.size} pools (logs + WMON seed via CREATE2)`);

  const nowIso = new Date().toISOString();

  const poolEntries = Array.from(pools.values());
  for (let i = 0; i < poolEntries.length; i += env.SNAPSHOT_BATCH_SIZE) {
    const batch = poolEntries.slice(i, i + env.SNAPSHOT_BATCH_SIZE);
    await Promise.allSettled(
      batch.map(async (p) => {
        const poolAddress = p.poolAddress;
          const [liquidity, slot0, token0Onchain, token1Onchain, tickSpacing] = await Promise.all([
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
            publicClient.readContract({
              address: poolAddress as `0x${string}`,
              abi: uniswapV3PoolAbi,
              functionName: "tickSpacing",
            }),
        ]);

        // slot0[0] is sqrtPriceX96 and slot0[1] is tick.
        const sqrtPriceX96 = (slot0 as unknown as { sqrtPriceX96: bigint }).sqrtPriceX96 ?? slot0[0];
        const tickCurrent = Number((slot0 as unknown as { tick: number }).tick ?? slot0[1]);
        const liquidityBig = liquidity as bigint;

        const token0Meta = await readTokenMeta(publicClient, String(token0Onchain));
        const token1Meta = await readTokenMeta(publicClient, String(token1Onchain));

        const poolMeta: PoolMeta = {
          poolAddress,
          dex: "uniswap_v3",
          tokenAddresses: [token0Meta.tokenAddress, token1Meta.tokenAddress],
        };

        // Persist pool + token catalogs so FK constraints hold.
        await Promise.all([
          upsertToken(db, token0Meta),
          upsertToken(db, token1Meta),
          upsertPool(db, poolMeta),
        ]);

        // Directional "max output within ±p% band" (liquidatable amount for a swap).
        // We store both directions for each pool: token0->token1 and token1->token0.
        const sqrtPriceX96Big = BigInt(sqrtPriceX96);
        const liquidityBigInt = liquidityBig;

        const bandsForTickWalk = Array.from(new Set([...bandList, depthSimpleBandBps])).sort((a, b) => a - b);

        let tickOutputsToken0To1: Record<number, bigint> = {};
        let tickOutputsToken1To0: Record<number, bigint> = {};

        try {
          tickOutputsToken0To1 = await uniswapV3DirectionalMaxOutputTickWalkForBands({
            publicClient,
            poolAddress,
            tickSpacing: tickSpacing as number,
            tickCurrent,
            liquidity: liquidityBigInt,
            sqrtPriceX96: sqrtPriceX96Big,
            bandBpsList: bandsForTickWalk,
            direction: "token0to1",
          });
        } catch (err) {
          console.error("uniswap_v3 tickWalk token0to1 failed", { poolAddress, err });
          for (const b of bandsForTickWalk) {
            tickOutputsToken0To1[b] = uniswapV3DirectionalMaxOutputRaw({
              liquidity: liquidityBigInt,
              sqrtPriceX96: sqrtPriceX96Big,
              bandBps: b,
              direction: "token0to1",
            });
          }
        }

        try {
          tickOutputsToken1To0 = await uniswapV3DirectionalMaxOutputTickWalkForBands({
            publicClient,
            poolAddress,
            tickSpacing: tickSpacing as number,
            tickCurrent,
            liquidity: liquidityBigInt,
            sqrtPriceX96: sqrtPriceX96Big,
            bandBpsList: bandsForTickWalk,
            direction: "token1to0",
          });
        } catch (err) {
          console.error("uniswap_v3 tickWalk token1to0 failed", { poolAddress, err });
          for (const b of bandsForTickWalk) {
            tickOutputsToken1To0[b] = uniswapV3DirectionalMaxOutputRaw({
              liquidity: liquidityBigInt,
              sqrtPriceX96: sqrtPriceX96Big,
              bandBps: b,
              direction: "token1to0",
            });
          }
        }

        const upserts: Array<ReturnType<typeof upsertPoolSwapDepthSnapshot>> = [];
        const depthSimpleBps = depthSimpleBandBps;

        for (const bandBps of bandList) {
          const depthSimpleToken0To1 = formatUnits(tickOutputsToken0To1[depthSimpleBps] ?? 0n, token1Meta.decimals);
          const depthBandToken0To1 = formatUnits(tickOutputsToken0To1[bandBps] ?? 0n, token1Meta.decimals);
          const depthSimpleToken1To0 = formatUnits(tickOutputsToken1To0[depthSimpleBps] ?? 0n, token0Meta.decimals);
          const depthBandToken1To0 = formatUnits(tickOutputsToken1To0[bandBps] ?? 0n, token0Meta.decimals);

          upserts.push(
            upsertPoolSwapDepthSnapshot(db, {
              timestamp: nowIso,
              dex: "uniswap_v3",
              poolAddress,
              bandBps,
              tokenIn: token0Meta.tokenAddress,
              tokenOut: token1Meta.tokenAddress,
              depthSimple: depthSimpleToken0To1,
              depthBand: depthBandToken0To1,
            }),
            upsertPoolSwapDepthSnapshot(db, {
              timestamp: nowIso,
              dex: "uniswap_v3",
              poolAddress,
              bandBps,
              tokenIn: token1Meta.tokenAddress,
              tokenOut: token0Meta.tokenAddress,
              depthSimple: depthSimpleToken1To0,
              depthBand: depthBandToken1To0,
            }),
          );
        }

        await Promise.all(upserts);

        // Compute spot price token1 per token0 (in real units), scaled 1e18.
        const spotPriceScaled = uniswapV3SpotPriceToken1PerToken0Scaled18({
          sqrtPriceX96,
          token0Decimals: token0Meta.decimals,
          token1Decimals: token1Meta.decimals,
        });

        const stable0 = STABLE_TOKENS_USD_1[normalizeAddress(token0Meta.tokenAddress)];
        const stable1 = STABLE_TOKENS_USD_1[normalizeAddress(token1Meta.tokenAddress)];
        const w0 = isWmon(token0Meta.tokenAddress);
        const w1 = isWmon(token1Meta.tokenAddress);

        let price0UsdScaled: bigint | undefined;
        let price1UsdScaled: bigint | undefined;

        if (stable0 && stable1) {
          price0UsdScaled = SCALE_1E18;
          price1UsdScaled = SCALE_1E18;
        } else if (stable0) {
          price0UsdScaled = SCALE_1E18;
          price1UsdScaled = spotPriceScaled;
        } else if (stable1) {
          price1UsdScaled = SCALE_1E18;
          price0UsdScaled = (SCALE_1E18 * SCALE_1E18) / spotPriceScaled;
        } else if (w0 && !w1) {
          // PoC: treat 1 WMON ≈ $1 for ranking
          price0UsdScaled = SCALE_1E18;
          price1UsdScaled = spotPriceScaled;
        } else if (!w0 && w1) {
          price1UsdScaled = SCALE_1E18;
          price0UsdScaled = (SCALE_1E18 * SCALE_1E18) / spotPriceScaled;
        }

        const simpleAmounts = uniswapV3BandAmountsRaw({
          liquidity: liquidityBig,
          sqrtPriceX96: BigInt(sqrtPriceX96),
          bandBps: depthSimpleBandBps,
        });

        const tokenAmounts: Record<string, string> = {
          [token0Meta.tokenAddress]: simpleAmounts.amount0.toString(),
          [token1Meta.tokenAddress]: simpleAmounts.amount1.toString(),
        };

        if (!price0UsdScaled || !price1UsdScaled) {
          // No USD/WMON anchor: store depth in token human units (still rankable per token after SUM).
          const poolSnap: PoolSnapshot = {
            timestamp: nowIso,
            dex: "uniswap_v3",
            poolAddress,
            tokenAmounts,
          };
          await upsertPoolSnapshot(db, poolSnap);

          const d0Simple = formatUnits(simpleAmounts.amount0, token0Meta.decimals);
          const d1Simple = formatUnits(simpleAmounts.amount1, token1Meta.decimals);
          await Promise.all(
            bandList.map(async (bandBps) => {
              const bandAmounts = uniswapV3BandAmountsRaw({
                liquidity: liquidityBig,
                sqrtPriceX96: BigInt(sqrtPriceX96),
                bandBps,
              });
              await upsertTokenDepthSnapshot(db, {
                timestamp: nowIso,
                dex: "uniswap_v3",
                tokenAddress: token0Meta.tokenAddress,
                bandBps,
                depthSimple: d0Simple,
                depthBand: formatUnits(bandAmounts.amount0, token0Meta.decimals),
              });
              await upsertTokenDepthSnapshot(db, {
                timestamp: nowIso,
                dex: "uniswap_v3",
                tokenAddress: token1Meta.tokenAddress,
                bandBps,
                depthSimple: d1Simple,
                depthBand: formatUnits(bandAmounts.amount1, token1Meta.decimals),
              });
            }),
          );
          return;
        }

        const pricesUsd: Record<string, string> = {
          [token0Meta.tokenAddress]: formatScaledUsd18ToPostgres(price0UsdScaled),
          [token1Meta.tokenAddress]: formatScaledUsd18ToPostgres(price1UsdScaled),
        };

        const poolSnap: PoolSnapshot = {
          timestamp: nowIso,
          dex: "uniswap_v3",
          poolAddress,
          tokenAmounts,
          tokenPricesUsd: pricesUsd,
        };
        await upsertPoolSnapshot(db, poolSnap);

        const token0SimpleUsdScaled =
          (simpleAmounts.amount0 * price0UsdScaled) / 10n ** BigInt(token0Meta.decimals);
        const token1SimpleUsdScaled =
          (simpleAmounts.amount1 * price1UsdScaled) / 10n ** BigInt(token1Meta.decimals);

        await Promise.all(
          bandList.map(async (bandBps) => {
            const bandAmounts = uniswapV3BandAmountsRaw({
              liquidity: liquidityBig,
              sqrtPriceX96: BigInt(sqrtPriceX96),
              bandBps,
            });

            const token0BandUsdScaled =
              (bandAmounts.amount0 * price0UsdScaled) / 10n ** BigInt(token0Meta.decimals);
            const token1BandUsdScaled =
              (bandAmounts.amount1 * price1UsdScaled) / 10n ** BigInt(token1Meta.decimals);

            await upsertTokenDepthSnapshot(db, {
              timestamp: nowIso,
              dex: "uniswap_v3",
              tokenAddress: token0Meta.tokenAddress,
              bandBps,
              depthSimple: formatScaledUsd18ToPostgres(token0SimpleUsdScaled),
              depthBand: formatScaledUsd18ToPostgres(token0BandUsdScaled),
            });
            await upsertTokenDepthSnapshot(db, {
              timestamp: nowIso,
              dex: "uniswap_v3",
              tokenAddress: token1Meta.tokenAddress,
              bandBps,
              depthSimple: formatScaledUsd18ToPostgres(token1SimpleUsdScaled),
              depthBand: formatScaledUsd18ToPostgres(token1BandUsdScaled),
            });
          }),
        );
      }),
    );
  }
}

