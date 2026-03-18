import type { PoolSnapshot, TokenDepthSnapshot } from "@monmon/shared";
import { uniswapV3BandAmountsRaw } from "@monmon/shared";
import type { Pool } from "pg";
import { createPublicClient, decodeEventLog, http, toBytes, toHex, keccak256, defineChain } from "viem";

import { upsertPool, upsertToken, type PoolMeta, type TokenMeta } from "../repositories/catalog";
import { upsertPoolSnapshot, upsertTokenDepthSnapshot } from "../repositories/snapshots";
import type { Env } from "../config";

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
const ONE = 1n;
const SCALE_1E18 = 10n ** 18n;

const STABLE_TOKENS_USD_1: Record<
  string,
  { symbol: string; decimals: number }
> = {
  // Common USD stables on Monad (addresses sourced from onchain references / deployed contracts).
  "0x754704bc059f8c67012fed69bc8a327a5aafb603": { symbol: "USDC", decimals: 6 },
  "0xe7cd86e13ac4309349f30b3435a9d337750fc82d": { symbol: "USDT", decimals: 6 },
  "0x00000000efe302beaa2b3e6e1b18d08d69a9012a": { symbol: "AUSD", decimals: 18 },
  // Optional: treat MON-wrapped as non-stable; we only price against the stables above.
};

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

  const logs = (await publicClient.request({
    method: "eth_getLogs",
    params: [
      {
        address: UNISWAP_V3_FACTORY,
        fromBlock: toHex(fromBlock),
        toBlock: toHex(toBlock),
        topics: [poolCreatedTopic0],
      },
    ],
  })) as Array<{ data: string; topics: string[] }>;

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

  console.log(`Uniswap v3 discovered ${pools.size} pools from last blocks window`);

  const nowIso = new Date().toISOString();

  const poolEntries = Array.from(pools.values());
  for (let i = 0; i < poolEntries.length; i += env.SNAPSHOT_BATCH_SIZE) {
    const batch = poolEntries.slice(i, i + env.SNAPSHOT_BATCH_SIZE);
    await Promise.allSettled(
      batch.map(async (p) => {
        const poolAddress = p.poolAddress;
        const token0Address = p.token0;
        const token1Address = p.token1;

        const [liquidity, slot0, token0Onchain, token1Onchain] = await Promise.all([
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
        ]);

        // slot0[0] is sqrtPriceX96
        const sqrtPriceX96 = (slot0 as unknown as { sqrtPriceX96: bigint }).sqrtPriceX96 ?? slot0[0];
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

        // Compute spot price token1 per token0 (in real units), scaled 1e18.
        const spotPriceScaled = uniswapV3SpotPriceToken1PerToken0Scaled18({
          sqrtPriceX96,
          token0Decimals: token0Meta.decimals,
          token1Decimals: token1Meta.decimals,
        });

        // Derive token USD prices only if one side is a stable.
        const stable0 = STABLE_TOKENS_USD_1[normalizeAddress(token0Meta.tokenAddress)];
        const stable1 = STABLE_TOKENS_USD_1[normalizeAddress(token1Meta.tokenAddress)];

        let price0UsdScaled: bigint | undefined;
        let price1UsdScaled: bigint | undefined;
        if (stable0 && !stable1) {
          price0UsdScaled = SCALE_1E18; // stable
          price1UsdScaled = spotPriceScaled; // token1 per token0
        } else if (!stable0 && stable1) {
          price1UsdScaled = SCALE_1E18; // stable
          // token0 price = 1 / (token1 per token0)
          price0UsdScaled = (SCALE_1E18 * SCALE_1E18) / spotPriceScaled;
        } else if (stable0 && stable1) {
          // Both are stables: treat as 1.0 each (good enough for MVP).
          price0UsdScaled = SCALE_1E18;
          price1UsdScaled = SCALE_1E18;
        }

        if (!price0UsdScaled || !price1UsdScaled) {
          // Can't value in USD without a stable anchor. Still write depth in token units later; MVP skips.
          return;
        }

        const pricesUsd: Record<string, string> = {
          [token0Meta.tokenAddress]: formatScaledUsd18ToPostgres(price0UsdScaled),
          [token1Meta.tokenAddress]: formatScaledUsd18ToPostgres(price1UsdScaled),
        };

        // Token amounts used for pool_snapshots at the "simple" band.
        const simpleAmounts = uniswapV3BandAmountsRaw({
          liquidity: liquidityBig,
          sqrtPriceX96: BigInt(sqrtPriceX96),
          bandBps: depthSimpleBandBps,
        });

        const tokenAmounts: Record<string, string> = {
          [token0Meta.tokenAddress]: simpleAmounts.amount0.toString(),
          [token1Meta.tokenAddress]: simpleAmounts.amount1.toString(),
        };

        const poolSnap: PoolSnapshot = {
          timestamp: nowIso,
          dex: "uniswap_v3",
          poolAddress,
          tokenAmounts,
          tokenPricesUsd: pricesUsd,
        };
        await upsertPoolSnapshot(db, poolSnap);

        // Persist token depth snapshots for each band.
        const token0SimpleUsdScaled = (simpleAmounts.amount0 * price0UsdScaled) / 10n ** BigInt(token0Meta.decimals);
        const token1SimpleUsdScaled = (simpleAmounts.amount1 * price1UsdScaled) / 10n ** BigInt(token1Meta.decimals);

        await Promise.all(
          bandList.map(async (bandBps) => {
            const bandAmounts = uniswapV3BandAmountsRaw({
              liquidity: liquidityBig,
              sqrtPriceX96: BigInt(sqrtPriceX96),
              bandBps,
            });

            const token0BandUsdScaled = (bandAmounts.amount0 * price0UsdScaled) / 10n ** BigInt(token0Meta.decimals);
            const token1BandUsdScaled = (bandAmounts.amount1 * price1UsdScaled) / 10n ** BigInt(token1Meta.decimals);

            const token0Depth: TokenDepthSnapshot = {
              timestamp: nowIso,
              dex: "uniswap_v3",
              tokenAddress: token0Meta.tokenAddress,
              bandBps,
              depthSimple: formatScaledUsd18ToPostgres(token0SimpleUsdScaled),
              depthBand: formatScaledUsd18ToPostgres(token0BandUsdScaled),
            };

            const token1Depth: TokenDepthSnapshot = {
              timestamp: nowIso,
              dex: "uniswap_v3",
              tokenAddress: token1Meta.tokenAddress,
              bandBps,
              depthSimple: formatScaledUsd18ToPostgres(token1SimpleUsdScaled),
              depthBand: formatScaledUsd18ToPostgres(token1BandUsdScaled),
            };

            await Promise.all([
              upsertTokenDepthSnapshot(db, token0Depth),
              upsertTokenDepthSnapshot(db, token1Depth),
            ]);
          }),
        );
      }),
    );
  }
}

