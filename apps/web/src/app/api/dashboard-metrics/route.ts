import { UNISWAP_V4_ALLOWED_TOKEN_SYMBOLS } from "@monmon/shared";
import { NextResponse } from "next/server";
import { getDb } from "../../../lib/db";
import { depthBandTimesUsd, getLatestTokenUsdPrice } from "../../../lib/tokenUsdPrice";

const DEXES = ["uniswap_v3", "uniswap_v4", "curve", "balancer", "lfj", "pancake"] as const;
const WMON = "0x3bd359c1119da7da1d913d1c4d2b7c461115433a";
const MON_NATIVE = "0x0000000000000000000000000000000000000000";
const COLLATERALS = [MON_NATIVE, WMON];
const TOKEN_IN_EXPAND = [MON_NATIVE, WMON];
const BANDS = [25, 100, 500] as const;
const allowedSymbols = [...UNISWAP_V4_ALLOWED_TOKEN_SYMBOLS];

export const dynamic = "force-dynamic";

function ratio(borrow: number, liq: number): string | null {
  if (!Number.isFinite(borrow) || !Number.isFinite(liq) || liq <= 0) return null;
  return String(borrow / liq);
}

export async function GET() {
  try {
    const db = getDb();

    const lendTsRes = await db.query(
      `SELECT max(ts) AS ts
       FROM lend_market_collateral_snapshots
       WHERE collateral_token = ANY($1::text[])`,
      [COLLATERALS],
    );
    const latestLendTs = lendTsRes.rows[0]?.ts as string | null;

    let monUsd: string | null = null;
    let wmonUsd: string | null = null;
    const borrowByProtocol: { protocol: string; usd: string }[] = [];

    if (latestLendTs) {
      const [monRow, wmonRow, protoRes] = await Promise.all([
        db.query(
          `SELECT SUM(borrowed_amount_usd) AS s
           FROM lend_market_collateral_snapshots
           WHERE ts = $1::timestamptz AND collateral_token = $2::text`,
          [latestLendTs, MON_NATIVE],
        ),
        db.query(
          `SELECT SUM(borrowed_amount_usd) AS s
           FROM lend_market_collateral_snapshots
           WHERE ts = $1::timestamptz AND collateral_token = $2::text`,
          [latestLendTs, WMON],
        ),
        db.query(
          `SELECT protocol, SUM(borrowed_amount_usd) AS s
           FROM lend_market_collateral_snapshots
           WHERE ts = $1::timestamptz AND collateral_token = ANY($2::text[])
           GROUP BY protocol
           ORDER BY SUM(borrowed_amount_usd) DESC NULLS LAST`,
          [latestLendTs, COLLATERALS],
        ),
      ]);
      monUsd = monRow.rows[0]?.s == null ? null : String(monRow.rows[0].s);
      wmonUsd = wmonRow.rows[0]?.s == null ? null : String(wmonRow.rows[0].s);
      for (const r of protoRes.rows as { protocol: string; s: unknown }[]) {
        if (r.s != null) borrowByProtocol.push({ protocol: String(r.protocol), usd: String(r.s) });
      }
    }

    const monN = monUsd != null ? Number(monUsd) : 0;
    const wmonN = wmonUsd != null ? Number(wmonUsd) : 0;
    const borrowUsdTotal = String(
      (Number.isFinite(monN) ? monN : 0) + (Number.isFinite(wmonN) ? wmonN : 0),
    );

    const bands: Array<{
      bandBps: number;
      latestSwapTs: string | null;
      liquidityUsdTotal: string;
      liquidityByDexUsd: Record<string, string>;
      safetyRatio: string | null;
    }> = [];

    let latestSwapTsOverall: string | null = null;

    for (const bandBps of BANDS) {
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
      const latestSwapTs = latestTsRes.rows[0]?.ts as string | null;
      if (latestSwapTs && !latestSwapTsOverall) latestSwapTsOverall = latestSwapTs;

      if (!latestSwapTs) {
        bands.push({
          bandBps,
          latestSwapTs: null,
          liquidityUsdTotal: "0",
          liquidityByDexUsd: {},
          safetyRatio: ratio(Number(borrowUsdTotal), 0),
        });
        continue;
      }

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
        [bandBps, [...DEXES], TOKEN_IN_EXPAND, latestSwapTs, allowedSymbols],
      );

      const uniqueTokens = new Set<string>();
      for (const r of byDexTokenRes.rows as { token_out: string }[]) {
        uniqueTokens.add(String(r.token_out).toLowerCase());
      }
      const priceMap = new Map<string, string | null>();
      await Promise.all(
        [...uniqueTokens].map(async (t) => {
          priceMap.set(t, await getLatestTokenUsdPrice(db, t));
        }),
      );

      const liquidityByDexUsd: Record<string, number> = {};
      let totalUsd = 0;
      for (const r of byDexTokenRes.rows as { dex: string; token_out: string; depth_band: string }[]) {
        const tok = String(r.token_out).toLowerCase();
        const price = priceMap.get(tok) ?? null;
        const usd = depthBandTimesUsd(String(r.depth_band ?? "0"), price);
        totalUsd += usd;
        const dex = String(r.dex);
        liquidityByDexUsd[dex] = (liquidityByDexUsd[dex] ?? 0) + usd;
      }

      const liquidityByDexUsdStr: Record<string, string> = {};
      for (const [k, v] of Object.entries(liquidityByDexUsd)) {
        liquidityByDexUsdStr[k] = String(v);
      }

      bands.push({
        bandBps,
        latestSwapTs,
        liquidityUsdTotal: String(totalUsd),
        liquidityByDexUsd: liquidityByDexUsdStr,
        safetyRatio: ratio(Number(borrowUsdTotal), totalUsd),
      });
    }

    return NextResponse.json({
      latestLendTs,
      latestSwapTs: latestSwapTsOverall,
      borrowUsdTotal,
      monUsd,
      wmonUsd,
      borrowByProtocol,
      bands,
      tokenIn: MON_NATIVE,
      dexScope: "all",
    });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "dashboard-metrics failed" }, { status: 500 });
  }
}
