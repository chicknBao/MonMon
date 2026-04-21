import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "../../../lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const days = Math.min(90, Math.max(1, Number(req.nextUrl.searchParams.get("days") ?? "30")));
    const db = getDb();
    const res = await db.query(
      `SELECT day, borrow_usd_total, liquidity_usd_band_25, liquidity_usd_band_100, liquidity_usd_band_500, ratio_band_100
       FROM dashboard_daily_rollups
       ORDER BY day DESC
       LIMIT $1`,
      [days],
    );
    const rows = (res.rows as Record<string, unknown>[]).map((r) => ({
      ...r,
      day:
        r.day instanceof Date
          ? r.day.toISOString().slice(0, 10)
          : String(r.day).slice(0, 10),
    }));
    return NextResponse.json({ rows });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "dashboard-history failed" }, { status: 500 });
  }
}
