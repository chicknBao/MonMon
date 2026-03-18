import { NextResponse } from "next/server";
import { getDb } from "../../../lib/db";

const DEXES = ["uniswap_v3", "curve", "balancer", "lfj"] as const;
type DexName = (typeof DEXES)[number] | "all";

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

function parseLimit(input: unknown): number {
  const n = Number(input ?? 200);
  if (!Number.isFinite(n) || n <= 0) return 200;
  return Math.min(1000, Math.max(1, Math.floor(n)));
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const dex = parseDex(url.searchParams.get("dex"));
    const tokenAddress = String(url.searchParams.get("tokenAddress") ?? "");
    const bandBps = parseBandBps(url.searchParams.get("bandBps"));
    const limit = parseLimit(url.searchParams.get("limit"));

    if (!tokenAddress) {
      return NextResponse.json({ error: "tokenAddress is required" }, { status: 400 });
    }

    const dexList = dex === "all" ? DEXES : [dex];
    const db = getDb();

    const seriesRes = await db.query(
      `SELECT
         t.dex,
         t.ts,
         t.depth_simple,
         t.depth_band,
         tok.symbol
       FROM token_depth_snapshots t
       LEFT JOIN tokens tok ON tok.token_address = t.token_address
       WHERE t.band_bps = $1
         AND t.dex = ANY($2::text[])
         AND t.token_address = $3
       ORDER BY t.ts ASC
       LIMIT $4`,
      [bandBps, dexList, tokenAddress.toLowerCase(), limit],
    );

    return NextResponse.json({
      dex,
      tokenAddress: tokenAddress.toLowerCase(),
      bandBps,
      series: seriesRes.rows.map((r: any) => ({
        dex: r.dex,
        timestamp: r.ts.toISOString(),
        depthSimple: r.depth_simple?.toString() ?? "0",
        depthBand: r.depth_band?.toString() ?? "0",
        symbol: r.symbol ?? tokenAddress,
      })),
    });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "token-series failed" }, { status: 500 });
  }
}

