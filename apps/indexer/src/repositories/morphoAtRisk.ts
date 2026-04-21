import type { Pool } from "pg";

/** Per HF band: position count and sum of Morpho position borrowAssetsUsd (when present). */
export type MorphoBandRollup = { count: number; borrowUsd: number };

export type MorphoPositionRollup = {
  timestamp: string;
  chainId: number;
  positionCount: number;
  histogram: Record<string, MorphoBandRollup>;
  topPositions: unknown[];
};

export async function upsertMorphoMarketPositionRollup(db: Pool, row: MorphoPositionRollup): Promise<void> {
  const ts = new Date(row.timestamp);
  await db.query(
    `
      INSERT INTO morpho_market_position_rollups (ts, chain_id, position_count, histogram, top_positions)
      VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
      ON CONFLICT (ts, chain_id) DO UPDATE SET
        position_count = EXCLUDED.position_count,
        histogram = EXCLUDED.histogram,
        top_positions = EXCLUDED.top_positions
    `,
    [ts.toISOString(), row.chainId, row.positionCount, JSON.stringify(row.histogram), JSON.stringify(row.topPositions)],
  );
}
