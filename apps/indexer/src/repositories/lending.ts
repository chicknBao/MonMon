import type { Pool } from "pg";

export type LendMarketCollateralSnapshot = {
  timestamp: string; // ISO
  protocol: string;
  marketId: string; // market identifier: could be address or bytes32, stored as text
  collateralToken: string;
  loanToken: string;
  borrowedAmount: string; // human units, as string
  borrowedAmountUsd?: string | null; // as string (postgres numeric-friendly)
};

export async function upsertLendMarketCollateralSnapshot(
  db: Pool,
  snapshot: LendMarketCollateralSnapshot,
) {
  const ts = new Date(snapshot.timestamp);
  await db.query(
    `
      INSERT INTO lend_market_collateral_snapshots (
        ts, protocol, market_id, collateral_token, loan_token, borrowed_amount, borrowed_amount_usd
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (ts, protocol, market_id, collateral_token, loan_token)
      DO UPDATE SET
        borrowed_amount = EXCLUDED.borrowed_amount,
        borrowed_amount_usd = COALESCE(EXCLUDED.borrowed_amount_usd, lend_market_collateral_snapshots.borrowed_amount_usd)
    `,
    [
      ts.toISOString(),
      snapshot.protocol,
      snapshot.marketId,
      snapshot.collateralToken,
      snapshot.loanToken,
      snapshot.borrowedAmount,
      snapshot.borrowedAmountUsd ?? null,
    ],
  );
}

