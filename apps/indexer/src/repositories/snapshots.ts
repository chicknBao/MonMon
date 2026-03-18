import type { PoolSnapshot, TokenDepthSnapshot } from "@monmon/shared";
import type { Pool } from "pg";

export async function upsertPoolSnapshot(db: Pool, snapshot: PoolSnapshot) {
  const ts = new Date(snapshot.timestamp);
  await db.query(
    `
      INSERT INTO pool_snapshots (ts, dex, pool_address, spot_price_usd, token_amounts, token_prices_usd)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (ts, pool_address)
      DO UPDATE SET
        token_amounts = EXCLUDED.token_amounts,
        token_prices_usd = EXCLUDED.token_prices_usd,
        spot_price_usd = EXCLUDED.spot_price_usd
    `,
    [
      ts.toISOString(),
      snapshot.dex,
      snapshot.poolAddress,
      null,
      JSON.stringify(snapshot.tokenAmounts),
      snapshot.tokenPricesUsd ? JSON.stringify(snapshot.tokenPricesUsd) : null,
    ],
  );
}

export async function upsertTokenDepthSnapshot(db: Pool, snapshot: TokenDepthSnapshot) {
  const ts = new Date(snapshot.timestamp);
  await db.query(
    `
      INSERT INTO token_depth_snapshots (
        ts, dex, token_address, band_bps, depth_simple, depth_band, token_price_usd
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (ts, dex, token_address, band_bps)
      DO UPDATE SET
        depth_simple = EXCLUDED.depth_simple,
        depth_band = EXCLUDED.depth_band,
        token_price_usd = EXCLUDED.token_price_usd
    `,
    [
      ts.toISOString(),
      snapshot.dex,
      snapshot.tokenAddress,
      snapshot.bandBps,
      snapshot.depthSimple,
      snapshot.depthBand,
      null,
    ],
  );
}

