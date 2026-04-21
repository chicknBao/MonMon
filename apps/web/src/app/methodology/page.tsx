import Link from "next/link";

export default function MethodologyPage() {
  return (
    <main className="pageMainNarrow">
      <h1 style={{ marginTop: 0 }}>Methodology</h1>
      <p>
        <Link href="/dashboard">Back to dashboard</Link>
      </p>

      <h2>Borrowed (MON + WMON collateral)</h2>
      <p>
        Totals come from the latest lending snapshot in <code>lend_market_collateral_snapshots</code>, summing{" "}
        <code>borrowed_amount_usd</code> where collateral is native MON or WMON. This is borrow-side exposure
        denominated in USD where the indexer could attach a price; rows without USD still count in token units on the
        Lend page.
      </p>

      <h2>Liquidity (MON in, USD estimate)</h2>
      <p>
        Swap &quot;liquidity&quot; uses directional max-output depth within a price band around each pool (see Swap
        page). For the dashboard we aggregate <code>depth_band</code> by output token and multiply by the latest USD
        price found in <code>pool_snapshots.token_prices_usd</code>. WMON, MON, and major stables are treated as $1
        when missing from that map.
      </p>
      <p>
        Summing across many output tokens is an <strong>estimate of economic depth</strong>, not guaranteed
        executable liquidation capacity and not a guarantee that liquidators can absorb all borrows at that price.
      </p>

      <h2>Safety ratio</h2>
      <p>
        <code>borrow USD ÷ liquidity USD</code> at a chosen band (we show 25, 100, and 500 bps). Lower liquidity at
        tighter bands raises the ratio. The ratio is a coarse indicator only.
      </p>

      <h2>Morpho health factor</h2>
      <p>
        Morpho sections use Morpho Blue&apos;s GraphQL <code>marketPositions</code> fields{" "}
        <code>healthFactor</code> and <code>priceVariationToLiquidationPrice</code> as returned by their API. We only
        include markets listed with MON or WMON as collateral asset, then aggregate counts into bands (including a
        separate band for health factor above 2). Where available, we also sum each position&apos;s{" "}
        <code>borrowAssetsUsd</code> into those bands for a coarse dollar view.
      </p>

      <h2>What we do not model</h2>
      <ul>
        <li>Oracle latency, partial fills, gas, MEV, and venue-specific execution rules.</li>
        <li>Per-user liquidation on Curvance/Neverland beyond what each integration exposes.</li>
      </ul>
    </main>
  );
}
