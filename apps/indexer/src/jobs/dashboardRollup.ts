import { UNISWAP_V4_ALLOWED_TOKEN_SYMBOLS } from "@monmon/shared";
import type { Pool } from "pg";
import type { Env } from "../config.js";

const DEXES = ["uniswap_v3", "uniswap_v4", "curve", "balancer", "lfj", "pancake"] as const;
const WMON = "0x3bd359c1119da7da1d913d1c4d2b7c461115433a";
const MON_NATIVE = "0x0000000000000000000000000000000000000000";
const COLLATERALS = [MON_NATIVE, WMON];
const TOKEN_IN_EXPAND = [MON_NATIVE, WMON];
const BANDS = [25, 100, 500] as const;
const allowedSymbols = [...UNISWAP_V4_ALLOWED_TOKEN_SYMBOLS];

const STABLE_USD_1 = new Set<string>([
  "0x754704bc059f8c67012fed69bc8a327a5aafb603",
  "0xe7cd86e13ac4309349f30b3435a9d337750fc82d",
  "0x00000000efe302beaa2b3e6e1b18d08d69a9012a",
]);

function norm(a: string): string {
  return a.toLowerCase();
}

async function tokenUsd(db: Pool, tokenAddress: string): Promise<number> {
  const addr = norm(tokenAddress);
  if (addr === norm(WMON) || addr === MON_NATIVE) return 1;
  if (STABLE_USD_1.has(addr)) return 1;
  const res = await db.query(
    `
      SELECT token_prices_usd->>$1 AS price
      FROM pool_snapshots
      WHERE token_prices_usd ? $1
      ORDER BY ts DESC
      LIMIT 1
    `,
    [addr],
  );
  const p = res.rows[0]?.price as string | null | undefined;
  const n = p != null ? Number(p) : NaN;
  return Number.isFinite(n) ? n : 0;
}

async function liquidityUsdForBand(db: Pool, bandBps: number): Promise<{ total: number; latestTs: string | null }> {
  const latestTsRes = await db.query(
    `SELECT max(ps.ts) AS ts
     FROM pool_swap_depth_snapshots ps
     LEFT JOIN tokens tin ON tin.token_address = ps.token_in
     LEFT JOIN tokens tout ON tout.token_address = ps.token_out
     WHERE ps.band_bps = $1
       AND ps.dex = ANY($2::text[])
       AND ps.token_in = ANY($3::text[])
       AND ps.depth_band > 0
       AND (
         ps.dex <> 'uniswap_v4'
         OR (
           UPPER(COALESCE(tin.symbol, '')) = ANY($4::text[])
           AND UPPER(COALESCE(tout.symbol, '')) = ANY($4::text[])
         )
       )`,
    [bandBps, [...DEXES], TOKEN_IN_EXPAND, allowedSymbols],
  );
  const latestTs = latestTsRes.rows[0]?.ts as string | null;
  if (!latestTs) return { total: 0, latestTs: null };

  const byDexTokenRes = await db.query(
    `SELECT ps.dex, ps.token_out, SUM(ps.depth_band)::numeric AS depth_band
     FROM pool_swap_depth_snapshots ps
     LEFT JOIN tokens tin ON tin.token_address = ps.token_in
     LEFT JOIN tokens tout ON tout.token_address = ps.token_out
     WHERE ps.band_bps = $1
       AND ps.dex = ANY($2::text[])
       AND ps.token_in = ANY($3::text[])
       AND ps.ts = $4::timestamptz
       AND ps.depth_band > 0
       AND (
         ps.dex <> 'uniswap_v4'
         OR (
           UPPER(COALESCE(tin.symbol, '')) = ANY($5::text[])
           AND UPPER(COALESCE(tout.symbol, '')) = ANY($5::text[])
         )
       )
     GROUP BY ps.dex, ps.token_out`,
    [bandBps, [...DEXES], TOKEN_IN_EXPAND, latestTs, allowedSymbols],
  );

  const tokens = new Set<string>();
  for (const r of byDexTokenRes.rows as { token_out: string }[]) {
    tokens.add(norm(r.token_out));
  }
  const priceMap = new Map<string, number>();
  await Promise.all(
    [...tokens].map(async (t) => {
      priceMap.set(t, await tokenUsd(db, t));
    }),
  );

  let total = 0;
  for (const r of byDexTokenRes.rows as { token_out: string; depth_band: string }[]) {
    const p = priceMap.get(norm(r.token_out)) ?? 0;
    const d = Number(r.depth_band ?? "0");
    if (Number.isFinite(d) && Number.isFinite(p)) total += d * p;
  }
  return { total, latestTs };
}

export async function runDashboardRollup(params: { env: Env; db: Pool; snapshotTs: string }): Promise<void> {
  const { env, db, snapshotTs } = params;
  const day = new Date(snapshotTs).toISOString().slice(0, 10);

  const lendTsRes = await db.query(
    `SELECT max(ts) AS ts FROM lend_market_collateral_snapshots WHERE collateral_token = ANY($1::text[])`,
    [COLLATERALS],
  );
  const latestLendTs = lendTsRes.rows[0]?.ts as string | null;
  let borrowUsd = 0;
  if (latestLendTs) {
    const b = await db.query(
      `SELECT SUM(borrowed_amount_usd) AS s
       FROM lend_market_collateral_snapshots
       WHERE ts = $1::timestamptz AND collateral_token = ANY($2::text[])`,
      [latestLendTs, COLLATERALS],
    );
    const s = b.rows[0]?.s;
    borrowUsd = s != null ? Number(s) : 0;
    if (!Number.isFinite(borrowUsd)) borrowUsd = 0;
  }

  const liq25 = await liquidityUsdForBand(db, BANDS[0]);
  const liq100 = await liquidityUsdForBand(db, BANDS[1]);
  const liq500 = await liquidityUsdForBand(db, BANDS[2]);

  const ratio100 = liq100.total > 0 && Number.isFinite(borrowUsd) ? borrowUsd / liq100.total : null;

  let morphoHistogram: unknown = null;
  const morphoRow = await db.query(
    `SELECT histogram FROM morpho_market_position_rollups WHERE chain_id = $1 AND ts = $2::timestamptz`,
    [env.MONAD_CHAIN_ID, new Date(snapshotTs).toISOString()],
  );
  if (morphoRow.rows[0]?.histogram) morphoHistogram = morphoRow.rows[0].histogram;

  await db.query(
    `
      INSERT INTO dashboard_daily_rollups (
        day, borrow_usd_total, liquidity_usd_band_25, liquidity_usd_band_100, liquidity_usd_band_500,
        ratio_band_100, morpho_histogram
      )
      VALUES ($1::date, $2, $3, $4, $5, $6, $7::jsonb)
      ON CONFLICT (day) DO UPDATE SET
        borrow_usd_total = EXCLUDED.borrow_usd_total,
        liquidity_usd_band_25 = EXCLUDED.liquidity_usd_band_25,
        liquidity_usd_band_100 = EXCLUDED.liquidity_usd_band_100,
        liquidity_usd_band_500 = EXCLUDED.liquidity_usd_band_500,
        ratio_band_100 = EXCLUDED.ratio_band_100,
        morpho_histogram = CASE
          WHEN EXCLUDED.morpho_histogram IS NOT NULL THEN EXCLUDED.morpho_histogram
          ELSE dashboard_daily_rollups.morpho_histogram
        END
    `,
    [
      day,
      borrowUsd,
      liq25.total,
      liq100.total,
      liq500.total,
      ratio100,
      morphoHistogram != null ? JSON.stringify(morphoHistogram) : null,
    ],
  );

  console.log(`dashboard-rollup: day=${day} borrowUsd=${borrowUsd} liq100=${liq100.total}`);
}
