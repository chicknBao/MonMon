import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "../../../lib/db";
import {
  getMonadRpcConfig,
  needsOnChainTokenMetadata,
  normalizeTokenAddress,
  persistTokenMetadataToDb,
  resolveTokenMetadataMap,
} from "../../../lib/tokenMetadata";

const WMON = "0x3bd359c1119da7da1d913d1c4d2b7c461115433a";
const MON_NATIVE = "0x0000000000000000000000000000000000000000";

type LendMarketSlot = {
  usd: string | null;
  amount: string; // borrowed amount (loan token units) as human string
  loanTokenSymbol: string | null;
};

type LendMarketRow = {
  protocol: string;
  marketId: string;
  mon: LendMarketSlot;
  wmon: LendMarketSlot;
};

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest) {
  try {
    const db = getDb();
    const collaterals = [MON_NATIVE, WMON];

    const latestTsRes = await db.query(
      `SELECT max(ts) AS ts
       FROM lend_market_collateral_snapshots
       WHERE collateral_token = ANY($1::text[])`,
      [collaterals],
    );
    const latestTs = latestTsRes.rows[0]?.ts as string | null;
    if (!latestTs) {
      return NextResponse.json({ latestTs: null, markets: [], all: { monUsd: null, wmonUsd: null } });
    }

    const rowsRes = await db.query(
      `SELECT
         protocol,
         market_id,
         collateral_token,
         loan_token,
         SUM(borrowed_amount) AS borrowed_amount,
         SUM(borrowed_amount_usd) AS borrowed_amount_usd,
         tl.symbol AS loan_symbol,
         tl.decimals AS loan_decimals
       FROM lend_market_collateral_snapshots lm
       LEFT JOIN tokens tl ON tl.token_address = lm.loan_token
       WHERE lm.ts = $1::timestamptz
         AND lm.collateral_token = ANY($2::text[])
       GROUP BY protocol, market_id, collateral_token, loan_token, tl.symbol, tl.decimals
       ORDER BY borrowed_amount_usd DESC NULLS LAST
       LIMIT 200`,
      [latestTs, collaterals],
    );

    const toResolve = new Set<string>();
    for (const r of rowsRes.rows as any[]) {
      const sym = r.loan_symbol as string | null | undefined;
      const addr = String(r.loan_token ?? "");
      if (addr) {
        if (needsOnChainTokenMetadata(sym, addr)) toResolve.add(addr);
      }
    }

    const { rpcUrl, chainId } = getMonadRpcConfig();
    const resolved = await resolveTokenMetadataMap([...toResolve], rpcUrl, chainId);
    if (resolved.size > 0) {
      await Promise.all([...resolved.values()].map((m) => persistTokenMetadataToDb(db, m)));
    }

    const pickLoanSymbol = (loanToken: string, fallback: string | null | undefined) => {
      const m = resolved.get(normalizeTokenAddress(loanToken));
      return m?.symbol ?? fallback ?? null;
    };

    const marketMap = new Map<string, LendMarketRow>();
    for (const r of rowsRes.rows as any[]) {
      const protocol = String(r.protocol);
      const marketId = String(r.market_id);
      const collateralToken = String(r.collateral_token).toLowerCase();
      const loanToken = String(r.loan_token);
      const borrowedAmount = String(r.borrowed_amount ?? "0");
      const borrowedUsd = r.borrowed_amount_usd == null ? null : String(r.borrowed_amount_usd);
      const loanSymbol = pickLoanSymbol(loanToken, r.loan_symbol);

      const key = `${protocol}:${marketId}`;
      const existing =
        marketMap.get(key) ??
        ({
          protocol,
          marketId,
          mon: { usd: null, amount: "0", loanTokenSymbol: loanSymbol },
          wmon: { usd: null, amount: "0", loanTokenSymbol: loanSymbol },
        } satisfies LendMarketRow);

      if (collateralToken === MON_NATIVE) {
        existing.mon = { usd: borrowedUsd, amount: borrowedAmount, loanTokenSymbol: loanSymbol };
      } else if (collateralToken === WMON) {
        existing.wmon = { usd: borrowedUsd, amount: borrowedAmount, loanTokenSymbol: loanSymbol };
      }

      marketMap.set(key, existing);
    }

    const markets = [...marketMap.values()].sort((a, b) => {
      const aUsd = (a.mon.usd ? Number(a.mon.usd) : 0) + (a.wmon.usd ? Number(a.wmon.usd) : 0);
      const bUsd = (b.mon.usd ? Number(b.mon.usd) : 0) + (b.wmon.usd ? Number(b.wmon.usd) : 0);
      return bUsd - aUsd;
    });

    const allMonUsdRes = await db.query(
      `SELECT SUM(borrowed_amount_usd) AS s
       FROM lend_market_collateral_snapshots
       WHERE ts = $1::timestamptz AND collateral_token = $2::text`,
      [latestTs, MON_NATIVE],
    );
    const allWmonUsdRes = await db.query(
      `SELECT SUM(borrowed_amount_usd) AS s
       FROM lend_market_collateral_snapshots
       WHERE ts = $1::timestamptz AND collateral_token = $2::text`,
      [latestTs, WMON],
    );

    const all = {
      monUsd: allMonUsdRes.rows[0]?.s == null ? null : String(allMonUsdRes.rows[0].s),
      wmonUsd: allWmonUsdRes.rows[0]?.s == null ? null : String(allWmonUsdRes.rows[0].s),
    };

    return NextResponse.json({ latestTs, markets, all });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "lend-markets failed" }, { status: 500 });
  }
}

