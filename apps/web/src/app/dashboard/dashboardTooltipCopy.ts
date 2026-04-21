/**
 * Layman-facing tooltip copy for the dashboard (aligned with /methodology).
 * Keep each blurb short; these are estimates, not financial advice.
 */
export const dashboardTooltips = {
  pageIntro:
    "This page is a snapshot from our database: it is not live chain data. Numbers update when the indexer last ran. Treat them as a rough picture, not trading advice.",

  staleLending:
    "If this timestamp is more than about 6 hours old, we label it stale. The borrow totals may not match the market right now.",

  staleSwap:
    "If this timestamp is more than about 6 hours old, we label it stale. The liquidity estimates may not match the market right now.",

  borrowedCard:
    "This is how much has been borrowed in lending markets where the borrower posted native MON or WMON as collateral. It answers: how big is MON-backed borrowing?",

  liquidityCard:
    "This estimates how much value you could theoretically get out of pools by selling MON (and WMON, treated like MON for routing) within the price band, then converts that to dollars using our latest saved prices. It is not a promise that liquidators can sell that much in practice.",

  safetyRatio:
    "We divide total borrowed (dollars) by this liquidity estimate (dollars). A higher number means more borrowing relative to the depth we see. It does not mean positions will or won’t liquidate cleanly.",

  stressBands:
    "Each row uses a different price band around the pool price. A smaller band (e.g. 25 bps) is stricter: less volume counts as “available” before the price moves out of range. Wider bands include more depth but are less strict.",

  morphoSection:
    "Morpho-only view of borrowers in markets that use MON or WMON as collateral. Health factor (HF) is Morpho’s own risk score; lower means closer to trouble. Counts and borrow dollars are summed from Morpho’s API per position, not other protocols.",

  morphoHistogramBorrowUsd:
    "Per band, we add Morpho’s borrowAssetsUsd for each position in that health-factor range. If the API omits USD for a position, it contributes $0 here. This is an estimate, not advice.",

  morphoHfColumn:
    "Health factor: Morpho’s summary of how safe this borrow looks. Above 1 is generally farther from liquidation; exactly how it is calculated is defined by Morpho.",

  morphoPriceVarColumn:
    "Morpho’s own estimate of how far the relevant price would need to move to reach liquidation territory for this position. It is a model output, not a prediction.",

  dailyHistory:
    "Each row is one calendar day (UTC) using our end-of-day rollup: borrow dollars vs liquidity at ±100 bps, and the ratio between them. Gaps mean the indexer had no rollup that day.",

  borrowByProtocol:
    "Each row is one lending source (e.g. Morpho, Curvance) and how much borrow dollar value we attributed to it in the latest snapshot. It helps you see where borrowing is concentrated.",

  liquidityByDex:
    "Each row is one DEX and our dollar estimate of MON-side depth at ±100 bps in the latest snapshot. It shows where sell-side liquidity is concentrated, not how good execution will be.",

  chartHistoryTrend:
    "Visual of the same daily UTC rollup as the table: borrow dollars vs liquidity at ±100 bps, plus the ratio. Hover a point for exact values; the table lists every day.",

  chartMorphoDistribution:
    "Same position counts per health-factor band as the table (bars), so you can see concentration at a glance. Dollar borrow per band is in the table only.",

  chartStressBands:
    "Liquidity estimate per band (bars) and borrow-to-liquidity ratio (line). Tighter bands count less depth; this complements the numeric table.",

  chartBorrowProtocol:
    "Borrow dollars by lending protocol from the latest snapshot. Bars match the table below.",

  chartDexLiquidity:
    "Estimated MON-side liquidity at ±100 bps by DEX. Bars match the table below.",
} as const;
