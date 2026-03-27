import type { PoolSnapshot, TokenDepthSnapshot } from "@monmon/shared";
import { formatUnits } from "@monmon/shared";
import type { Pool } from "pg";
import { createPublicClient } from "viem";
import type { Env } from "../config.js";
import { createMonadPublicClient } from "../monadPublicClient.js";
import { upsertPool, upsertToken, type PoolMeta, type TokenMeta } from "../repositories/catalog.js";
import {
  upsertPoolSnapshot,
  upsertPoolSwapDepthSnapshot,
  upsertTokenDepthSnapshot,
} from "../repositories/snapshots.js";

// LBFactory / LBRouter (LFJ v2.2; per-pool quotes use router getSwapOut)
const LBF_FACTORY = "0xb43120c4745967fa9b93E79C149E66B0f2D6Fe0c";
const LB_ROUTER = "0x18556DA13313f3532c54711497A8FedAC273220E";

const lbfactoryAbi = [
  {
    type: "function",
    name: "getNumberOfLBPairs",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getLBPairAtIndex",
    stateMutability: "view",
    inputs: [{ name: "index", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

const lbPairAbi = [
  {
    type: "function",
    name: "getTokenX",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "getTokenY",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "getReserves",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "reserveX", type: "uint128" },
      { name: "reserveY", type: "uint128" },
    ],
  },
] as const;

const lbRouterGetSwapOutAbi = [
  {
    type: "function",
    name: "getSwapOut",
    stateMutability: "view",
    inputs: [
      { name: "LBPair", type: "address" },
      { name: "amountIn", type: "uint128" },
      { name: "swapForY", type: "bool" },
    ],
    outputs: [
      { name: "amountInLeft", type: "uint128" },
      { name: "amountOut", type: "uint128" },
      { name: "fee", type: "uint128" },
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

const SCALE_1E18 = 10n ** 18n;

const STABLE_TOKENS_USD_1: Record<
  string,
  { symbol: string; decimals: number }
> = {
  "0x754704bc059f8c67012fed69bc8a327a5aafb603": { symbol: "USDC", decimals: 6 },
  "0xe7cd86e13ac4309349f30b3435a9d337750fc82d": { symbol: "USDT", decimals: 6 },
  // AUSD has 6 decimals onchain.
  "0x00000000efe302beaa2b3e6e1b18d08d69a9012a": { symbol: "AUSD", decimals: 6 },
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

const MAX_U128 = (1n << 128n) - 1n;

function toUint128(n: bigint): bigint {
  if (n <= 0n) return 0n;
  return n > MAX_U128 ? MAX_U128 : n;
}

function amountInRawForBand(balanceIn: bigint, bandBps: number): bigint {
  if (balanceIn === 0n) return 0n;
  const raw = (balanceIn * BigInt(bandBps)) / 10000n;
  if (raw === 0n) return 0n;
  return raw < balanceIn ? raw : balanceIn - 1n;
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

async function readTokenMeta(publicClient: ReturnType<typeof createPublicClient>, tokenAddress: string): Promise<TokenMeta> {
  const addr = normalizeAddress(tokenAddress);
  const stable = STABLE_TOKENS_USD_1[addr];
  if (stable) return { tokenAddress: addr, symbol: stable.symbol, decimals: stable.decimals };

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

function spotPriceTokenYPerTokenXScaled18(params: {
  reserveX: bigint;
  reserveY: bigint;
  tokenXDecimals: number;
  tokenYDecimals: number;
}): bigint | undefined {
  const { reserveX, reserveY, tokenXDecimals, tokenYDecimals } = params;
  if (reserveX === 0n) return undefined;

  // spot = (reserveY / 10^decY) / (reserveX / 10^decX) = (reserveY / reserveX) * 10^(decX-decY)
  const decDiff = tokenXDecimals - tokenYDecimals;

  let numerator = reserveY * SCALE_1E18;
  if (decDiff >= 0) numerator *= 10n ** BigInt(decDiff);
  else numerator /= 10n ** BigInt(-decDiff);

  return numerator / reserveX;
}

export async function runLfjDepthSnapshot(params: { env: Env; db: Pool; snapshotTs?: string }) {
  const { env, db, snapshotTs } = params;
  const bandList = parseBandList(env.BAND_BPS_LIST);
  if (bandList.length === 0) throw new Error("BAND_BPS_LIST produced no valid bands");

  const publicClient = createMonadPublicClient(env);

  const pairCount = Number(
    await publicClient.readContract({
      address: LBF_FACTORY as `0x${string}`,
      abi: lbfactoryAbi,
      functionName: "getNumberOfLBPairs",
    }),
  );

  const maxPairs = Math.min(pairCount, env.DISCOVERY_MAX_POOLS);
  console.log(`LFJ factory reports ${pairCount} pairs; snapshotting up to ${maxPairs}`);

  const nowIso = snapshotTs ?? new Date().toISOString();

  const pairAddresses: string[] = [];
  for (let i = 0; i < maxPairs; i++) {
    const pairAddress = await publicClient.readContract({
      address: LBF_FACTORY as `0x${string}`,
      abi: lbfactoryAbi,
      functionName: "getLBPairAtIndex",
      args: [BigInt(i)],
    });
    pairAddresses.push(normalizeAddress(String(pairAddress)));
  }

  for (let i = 0; i < pairAddresses.length; i += env.SNAPSHOT_BATCH_SIZE) {
    const batch = pairAddresses.slice(i, i + env.SNAPSHOT_BATCH_SIZE);
    await Promise.allSettled(
      batch.map(async (pairAddress) => {
        const [tokenXAddr, tokenYAddr, [reserveX, reserveY]] = await Promise.all([
          publicClient.readContract({
            address: pairAddress as `0x${string}`,
            abi: lbPairAbi,
            functionName: "getTokenX",
          }),
          publicClient.readContract({
            address: pairAddress as `0x${string}`,
            abi: lbPairAbi,
            functionName: "getTokenY",
          }),
          publicClient.readContract({
            address: pairAddress as `0x${string}`,
            abi: lbPairAbi,
            functionName: "getReserves",
          }),
        ]);

        const tokenX = normalizeAddress(String(tokenXAddr));
        const tokenY = normalizeAddress(String(tokenYAddr));

        const tokenXMeta = await readTokenMeta(publicClient, tokenX);
        const tokenYMeta = await readTokenMeta(publicClient, tokenY);

        const stableX = STABLE_TOKENS_USD_1[tokenX];
        const stableY = STABLE_TOKENS_USD_1[tokenY];

        const spotScaled = spotPriceTokenYPerTokenXScaled18({
          reserveX: reserveX as bigint,
          reserveY: reserveY as bigint,
          tokenXDecimals: tokenXMeta.decimals,
          tokenYDecimals: tokenYMeta.decimals,
        });

        let priceXUsdScaled: bigint | undefined;
        let priceYUsdScaled: bigint | undefined;
        if (stableX && !stableY) {
          priceXUsdScaled = SCALE_1E18;
          priceYUsdScaled = spotScaled;
        } else if (!stableX && stableY) {
          priceYUsdScaled = SCALE_1E18;
          priceXUsdScaled = spotScaled ? (SCALE_1E18 * SCALE_1E18) / spotScaled : undefined;
        } else if (stableX && stableY) {
          priceXUsdScaled = SCALE_1E18;
          priceYUsdScaled = SCALE_1E18;
        }

        if (!priceXUsdScaled || !priceYUsdScaled || !spotScaled) {
          return;
        }

        const tokenPriceUsd: Record<string, string> = {
          [tokenXMeta.tokenAddress]: formatScaledUsd18ToPostgres(priceXUsdScaled),
          [tokenYMeta.tokenAddress]: formatScaledUsd18ToPostgres(priceYUsdScaled),
        };

        const poolMeta: PoolMeta = {
          poolAddress: pairAddress,
          dex: "lfj",
          tokenAddresses: [tokenXMeta.tokenAddress, tokenYMeta.tokenAddress],
        };

        await Promise.all([
          upsertPool(db, poolMeta),
          upsertToken(db, tokenXMeta),
          upsertToken(db, tokenYMeta),
        ]);

        const tokenAmounts: Record<string, string> = {
          [tokenXMeta.tokenAddress]: (reserveX as bigint).toString(),
          [tokenYMeta.tokenAddress]: (reserveY as bigint).toString(),
        };

        const poolSnap: PoolSnapshot = {
          timestamp: nowIso,
          dex: "lfj",
          poolAddress: pairAddress,
          tokenAmounts,
          tokenPricesUsd: tokenPriceUsd,
        };
        await upsertPoolSnapshot(db, poolSnap);

        const tokenXSimpleUsdScaled = ((reserveX as bigint) * priceXUsdScaled) / 10n ** BigInt(tokenXMeta.decimals);
        const tokenYSimpleUsdScaled = ((reserveY as bigint) * priceYUsdScaled) / 10n ** BigInt(tokenYMeta.decimals);

        const depthSimpleX = formatScaledUsd18ToPostgres(tokenXSimpleUsdScaled);
        const depthSimpleY = formatScaledUsd18ToPostgres(tokenYSimpleUsdScaled);

        // MVP: use same depth within band as depthSimple for LB pairs.
        await Promise.all(
          bandList.map(async (bandBps) => {
            const snapX: TokenDepthSnapshot = {
              timestamp: nowIso,
              dex: "lfj",
              tokenAddress: tokenXMeta.tokenAddress,
              bandBps,
              depthSimple: depthSimpleX,
              depthBand: depthSimpleX,
            };
            const snapY: TokenDepthSnapshot = {
              timestamp: nowIso,
              dex: "lfj",
              tokenAddress: tokenYMeta.tokenAddress,
              bandBps,
              depthSimple: depthSimpleY,
              depthBand: depthSimpleY,
            };
            await Promise.all([
              upsertTokenDepthSnapshot(db, snapX),
              upsertTokenDepthSnapshot(db, snapY),
            ]);
          }),
        );

        const depthSimpleBps = env.DEPTH_SIMPLE_BAND_BPS;
        const reserveXb = reserveX as bigint;
        const reserveYb = reserveY as bigint;

        const swapRows: Array<ReturnType<typeof upsertPoolSwapDepthSnapshot>> = [];

        for (const [src, dst, reserveIn, swapForY] of [
          [tokenXMeta, tokenYMeta, reserveXb, true] as const,
          [tokenYMeta, tokenXMeta, reserveYb, false] as const,
        ]) {
          const amountSimpleIn = toUint128(amountInRawForBand(reserveIn, depthSimpleBps));
          if (amountSimpleIn === 0n) continue;

          let depthSimpleStr: string;
          try {
            const q = (await publicClient.readContract({
              address: LB_ROUTER as `0x${string}`,
              abi: lbRouterGetSwapOutAbi,
              functionName: "getSwapOut",
              args: [pairAddress as `0x${string}`, amountSimpleIn, swapForY],
            })) as readonly [bigint, bigint, bigint];
            const amountOut = q[1];
            depthSimpleStr = formatUnits(amountOut, dst.decimals);
          } catch {
            continue;
          }

          for (const bandBps of bandList) {
            const amountBandIn = toUint128(amountInRawForBand(reserveIn, bandBps));
            if (amountBandIn === 0n) continue;

            try {
              const q = (await publicClient.readContract({
                address: LB_ROUTER as `0x${string}`,
                abi: lbRouterGetSwapOutAbi,
                functionName: "getSwapOut",
                args: [pairAddress as `0x${string}`, amountBandIn, swapForY],
              })) as readonly [bigint, bigint, bigint];
              const amountOut = q[1];
              const depthBandStr = formatUnits(amountOut, dst.decimals);
              swapRows.push(
                upsertPoolSwapDepthSnapshot(db, {
                  timestamp: nowIso,
                  dex: "lfj",
                  poolAddress: pairAddress,
                  bandBps,
                  tokenIn: src.tokenAddress,
                  tokenOut: dst.tokenAddress,
                  depthSimple: depthSimpleStr,
                  depthBand: depthBandStr,
                }),
              );
            } catch {
              // Skip band on revert (illiquid / router guard).
            }
          }
        }

        await Promise.all(swapRows);
      }),
    );
  }
}

