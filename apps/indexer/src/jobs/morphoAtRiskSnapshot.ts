import type { Pool } from "pg";
import type { Env } from "../config.js";
import { upsertMorphoMarketPositionRollup, type MorphoBandRollup } from "../repositories/morphoAtRisk.js";

const MORPHO_GRAPHQL = "https://blue-api.morpho.org/graphql";
const WMON = "0x3bd359c1119da7da1d913d1c4d2b7c461115433a";
const MON_NATIVE = "0x0000000000000000000000000000000000000000";

type MorphoMarketItem = { marketId: string };
type MorphoPositionItem = {
  healthFactor: number | null;
  priceVariationToLiquidationPrice: number | null;
  user: { address: string };
  market: { marketId: string; loanAsset?: { symbol?: string | null } | null };
  state?: { borrowAssets?: unknown; borrowAssetsUsd?: unknown; collateral?: unknown } | null;
};

function emptyBand(): MorphoBandRollup {
  return { count: 0, borrowUsd: 0 };
}

function positionBorrowUsd(p: MorphoPositionItem): number {
  const raw = p.state?.borrowAssetsUsd;
  if (raw == null) return 0;
  const n = Number(String(raw).replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

async function morphoGql<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch(MORPHO_GRAPHQL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Morpho graphql HTTP ${res.status}`);
  const json: any = await res.json();
  if (json.errors?.length) throw new Error(JSON.stringify(json.errors));
  return json.data as T;
}

async function fetchMonCollateralMarketIds(chainId: number, first: number): Promise<string[]> {
  const data = await morphoGql<{
    markets: { items: MorphoMarketItem[] };
  }>({
    query: `
      query M($chainId: Int!, $collateralAssets: [String!], $first: Int!) {
        markets(
          first: $first,
          orderBy: BorrowAssetsUsd,
          orderDirection: Desc,
          where: { chainId_in: [$chainId], collateralAssetAddress_in: $collateralAssets, listed: true }
        ) {
          items { marketId }
        }
      }
    `,
    variables: {
      chainId,
      collateralAssets: [WMON, MON_NATIVE],
      first,
    },
  });
  const ids = (data.markets?.items ?? []).map((m) => String(m.marketId)).filter(Boolean);
  return [...new Set(ids)];
}

const PAGE = 250;
const MAX_POSITIONS = 25_000;
const MARKET_CHUNK = 20;

function bucketHf(hf: number | null | undefined): string | null {
  if (hf == null || !Number.isFinite(hf)) return null;
  if (hf < 1) return "lt_1";
  if (hf < 1.05) return "gte_1_lt_1_05";
  if (hf < 1.1) return "gte_1_05_lt_1_1";
  if (hf < 1.2) return "gte_1_1_lt_1_2";
  if (hf < 1.5) return "gte_1_2_lt_1_5";
  if (hf < 2) return "gte_1_5_lt_2";
  return "gte_2";
}

export async function runMorphoAtRiskSnapshot(params: { env: Env; db: Pool; snapshotTs: string }): Promise<number> {
  const { env, snapshotTs } = params;
  const chainId = env.MONAD_CHAIN_ID;

  const marketIds = await fetchMonCollateralMarketIds(chainId, Math.max(1, env.DISCOVERY_MAX_POOLS));
  if (marketIds.length === 0) {
    console.log("morpho-at-risk: no MON/WMON collateral markets");
    return 0;
  }

  const positions: MorphoPositionItem[] = [];
  let totalFetched = 0;

  for (let mi = 0; mi < marketIds.length; mi += MARKET_CHUNK) {
    const chunk = marketIds.slice(mi, mi + MARKET_CHUNK);
    let skip = 0;
    for (;;) {
      const data = await morphoGql<{
        marketPositions: { items: MorphoPositionItem[] };
      }>({
        query: `
          query P($first: Int!, $skip: Int!, $where: MarketPositionFilters!) {
            marketPositions(first: $first, skip: $skip, orderBy: HealthFactor, orderDirection: Asc, where: $where) {
              items {
                healthFactor
                priceVariationToLiquidationPrice
                user { address }
                market { marketId loanAsset { symbol } }
                state { borrowAssets borrowAssetsUsd collateral }
              }
            }
          }
        `,
        variables: {
          first: PAGE,
          skip,
          where: {
            chainId_in: [chainId],
            marketUniqueKey_in: chunk,
            borrowShares_gte: "1",
          },
        },
      });
      const batch = data.marketPositions?.items ?? [];
      if (batch.length === 0) break;
      positions.push(...batch);
      totalFetched += batch.length;
      skip += PAGE;
      if (batch.length < PAGE) break;
      if (totalFetched >= MAX_POSITIONS) {
        console.warn(`morpho-at-risk: capped at ${MAX_POSITIONS} positions`);
        break;
      }
    }
    if (totalFetched >= MAX_POSITIONS) break;
  }

  const histogram: Record<string, MorphoBandRollup> = {
    lt_1: emptyBand(),
    gte_1_lt_1_05: emptyBand(),
    gte_1_05_lt_1_1: emptyBand(),
    gte_1_1_lt_1_2: emptyBand(),
    gte_1_2_lt_1_5: emptyBand(),
    gte_1_5_lt_2: emptyBand(),
    gte_2: emptyBand(),
    unknown: emptyBand(),
  };

  for (const p of positions) {
    const b = bucketHf(p.healthFactor);
    const usd = positionBorrowUsd(p);
    const slot = b == null ? histogram.unknown : histogram[b]!;
    slot.count += 1;
    slot.borrowUsd += usd;
  }

  const sorted = [...positions].sort((a, b) => (a.healthFactor ?? 999) - (b.healthFactor ?? 999));
  const topPositions = sorted.slice(0, 30).map((p) => ({
    user: p.user?.address,
    marketId: p.market?.marketId,
    loanSymbol: p.market?.loanAsset?.symbol ?? null,
    healthFactor: p.healthFactor,
    priceVariationToLiquidationPrice: p.priceVariationToLiquidationPrice,
    borrowAssets: p.state?.borrowAssets != null ? String(p.state.borrowAssets) : null,
    collateral: p.state?.collateral != null ? String(p.state.collateral) : null,
  }));

  await upsertMorphoMarketPositionRollup(params.db, {
    timestamp: snapshotTs,
    chainId,
    positionCount: positions.length,
    histogram,
    topPositions,
  });

  console.log(`morpho-at-risk: stored ${positions.length} positions across ${marketIds.length} markets`);
  return positions.length;
}
