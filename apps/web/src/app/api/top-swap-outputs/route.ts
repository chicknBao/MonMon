import { NextResponse, type NextRequest } from "next/server";
import { UNISWAP_V4_ALLOWED_TOKEN_SYMBOLS } from "@monmon/shared";
import { getDb } from "../../../lib/db";

const DEXES = ["uniswap_v3", "uniswap_v4", "curve", "balancer", "lfj"] as const;
type DexName = (typeof DEXES)[number] | "all";

/** Wrapped MON on Monad — Curve pools use this as the coin, not native 0x0. */
const WMON = "0x3bd359c1119da7da1d913d1c4d2b7c461115433a";
const MON_NATIVE = "0x0000000000000000000000000000000000000000";

/** Map UI tokenIn to on-chain addresses (native MON ↔ WMON). */
function expandTokenInAddresses(tokenIn: string): string[] {
  const t = tokenIn.toLowerCase();
  if (t === MON_NATIVE) return [MON_NATIVE, WMON];
  if (t === WMON) return [WMON, MON_NATIVE];
  return [t];
}

export const dynamic = "force-dynamic";

function parseDex(input: unknown): DexName {
  const s = String(input ?? "uniswap_v3");
  if (s === "all") return "all";
  if ((DEXES as readonly string[]).includes(s)) return s as DexName;
  return "uniswap_v3";
}

function parseBandBps(input: unknown): number {
  const n = Number(input ?? 100);
  if (!Number.isFinite(n) || n <= 0 || n >= 20000) return 100;
  return n;
}

function parseLimit(input: unknown, min: number, max: number): number {
  const n = Number(input ?? min);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export async function GET(req: NextRequest) {
  try {
    const searchParams = req.nextUrl.searchParams;
    const dex = parseDex(searchParams.get("dex"));
    const tokenIn = String(searchParams.get("tokenIn") ?? "").toLowerCase();
    const bandBps = parseBandBps(searchParams.get("bandBps"));
    const limitTokens = parseLimit(searchParams.get("limitTokens"), 1, 100);
    const limitPools = parseLimit(searchParams.get("limitPools"), 1, 200);

    if (!tokenIn) {
      return NextResponse.json({ error: "tokenIn is required" }, { status: 400 });
    }

    const dexList = dex === "all" ? DEXES : [dex];
    const allowedSymbols = [...UNISWAP_V4_ALLOWED_TOKEN_SYMBOLS];
    const tokenInAddrs = expandTokenInAddresses(tokenIn);
    const db = getDb();

    // Symbol whitelist applies only to uniswap_v4 rows (see WHERE below).
    const latestTsRes = await db.query(
      `SELECT max(ps.ts) AS ts
       FROM pool_swap_depth_snapshots ps
       LEFT JOIN tokens tin ON tin.token_address = ps.token_in
       LEFT JOIN tokens tout ON tout.token_address = ps.token_out
       WHERE ps.band_bps = $1
         AND ps.dex = ANY($2::text[])
         AND ps.token_in = ANY($3::text[])
         AND (
           ps.dex <> 'uniswap_v4'
           OR (
             UPPER(COALESCE(tin.symbol, '')) = ANY($4::text[])
             AND UPPER(COALESCE(tout.symbol, '')) = ANY($4::text[])
           )
         )`,
      [bandBps, dexList, tokenInAddrs, allowedSymbols],
    );

    const latestTs = latestTsRes.rows[0]?.ts as string | null;
    if (!latestTs) {
      return NextResponse.json({ dex, tokenIn, bandBps, latestTs: null, totals: [], pools: [] });
    }

    const totalsRes = await db.query(
      `SELECT
         ps.token_out,
         COALESCE(tout.symbol, ps.token_out) AS symbol,
         COALESCE(tout.decimals, 0) AS decimals,
         SUM(ps.depth_simple) AS depth_simple,
         SUM(ps.depth_band) AS depth_band
       FROM pool_swap_depth_snapshots ps
       LEFT JOIN tokens tin ON tin.token_address = ps.token_in
       LEFT JOIN tokens tout ON tout.token_address = ps.token_out
       WHERE ps.band_bps = $1
         AND ps.dex = ANY($2::text[])
         AND ps.token_in = ANY($3::text[])
         AND ps.ts = $4::timestamptz
         AND (
           ps.dex <> 'uniswap_v4'
           OR (
             UPPER(COALESCE(tin.symbol, '')) = ANY($5::text[])
             AND UPPER(COALESCE(tout.symbol, '')) = ANY($5::text[])
           )
         )
       GROUP BY
         ps.token_out,
         COALESCE(tout.symbol, ps.token_out),
         COALESCE(tout.decimals, 0)
       ORDER BY depth_band DESC
       LIMIT $6`,
      [bandBps, dexList, tokenInAddrs, latestTs, allowedSymbols, limitTokens],
    );

    const poolsRes = await db.query(
      `SELECT
         ps.dex,
         ps.pool_address,
         ps.token_out,
         COALESCE(tout.symbol, ps.token_out) AS symbol,
         COALESCE(tout.decimals, 0) AS decimals,
         ps.depth_simple,
         ps.depth_band
       FROM pool_swap_depth_snapshots ps
       LEFT JOIN tokens tin ON tin.token_address = ps.token_in
       LEFT JOIN tokens tout ON tout.token_address = ps.token_out
       WHERE ps.band_bps = $1
         AND ps.dex = ANY($2::text[])
         AND ps.token_in = ANY($3::text[])
         AND ps.ts = $4::timestamptz
         AND (
           ps.dex <> 'uniswap_v4'
           OR (
             UPPER(COALESCE(tin.symbol, '')) = ANY($5::text[])
             AND UPPER(COALESCE(tout.symbol, '')) = ANY($5::text[])
           )
         )
       ORDER BY ps.depth_band DESC
       LIMIT $6`,
      [bandBps, dexList, tokenInAddrs, latestTs, allowedSymbols, limitPools],
    );

    return NextResponse.json({
      dex,
      tokenIn,
      bandBps,
      latestTs,
      totals: totalsRes.rows.map((r: any) => ({
        tokenOut: r.token_out,
        symbol: r.symbol,
        decimals: Number(r.decimals),
        depthSimple: r.depth_simple?.toString() ?? "0",
        depthBand: r.depth_band?.toString() ?? "0",
      })),
      pools: poolsRes.rows.map((r: any) => ({
        dex: r.dex,
        poolAddress: r.pool_address,
        tokenOut: r.token_out,
        symbol: r.symbol,
        decimals: Number(r.decimals),
        depthSimple: r.depth_simple?.toString() ?? "0",
        depthBand: r.depth_band?.toString() ?? "0",
      })),
    });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "top-swap-outputs failed" }, { status: 500 });
  }
}

