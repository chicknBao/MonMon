import { NextResponse } from "next/server";
import { getDb } from "../../../lib/db";
import { getMonadRpcConfig } from "../../../lib/tokenMetadata";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { chainId } = getMonadRpcConfig();
    const db = getDb();
    const res = await db.query(
      `SELECT ts, chain_id, position_count, histogram, top_positions
       FROM morpho_market_position_rollups
       WHERE chain_id = $1
       ORDER BY ts DESC
       LIMIT 1`,
      [chainId],
    );
    const row = res.rows[0];
    if (!row) {
      return NextResponse.json({
        latestTs: null,
        chainId,
        positionCount: 0,
        histogram: null,
        topPositions: [],
      });
    }
    return NextResponse.json({
      latestTs: row.ts as string,
      chainId: row.chain_id as number,
      positionCount: row.position_count as number,
      histogram: row.histogram,
      topPositions: row.top_positions,
    });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "morpho-at-risk failed" }, { status: 500 });
  }
}
