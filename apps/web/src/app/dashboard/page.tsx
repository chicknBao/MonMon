"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  BandsLiquidityChart,
  BorrowByProtocolChart,
  DexLiquidityChart,
  HistoryBorrowLiquidityChart,
  MorphoHistogramChart,
} from "../../components/dashboard/DashboardCharts";
import { DashboardInfoTip } from "../../components/DashboardInfoTip";
import {
  buildBandChartRows,
  buildDexChartRows,
  buildHistoryChartData,
  buildProtocolChartRows,
  MORPHO_HISTOGRAM_LABELS,
  orderedMorphoHistogramEntries,
} from "./dashboardChartData";
import { formatDepthNumber } from "./dashboardFormat";
import { dashboardTooltips } from "./dashboardTooltipCopy";

const MON = "0x0000000000000000000000000000000000000000";
const STALE_MS = 6 * 60 * 60 * 1000;

type DashboardMetrics = {
  latestLendTs: string | null;
  latestSwapTs: string | null;
  borrowUsdTotal: string;
  monUsd: string | null;
  wmonUsd: string | null;
  borrowByProtocol: { protocol: string; usd: string }[];
  bands: Array<{
    bandBps: number;
    latestSwapTs: string | null;
    liquidityUsdTotal: string;
    liquidityByDexUsd: Record<string, string>;
    safetyRatio: string | null;
  }>;
};

type MorphoAtRiskResponse = {
  latestTs: string | null;
  positionCount: number;
  histogram: Record<string, number> | null;
  topPositions: Array<{
    user?: string;
    marketId?: string;
    loanSymbol?: string | null;
    healthFactor?: number | null;
    priceVariationToLiquidationPrice?: number | null;
  }>;
};

type HistoryRow = {
  day: string;
  borrow_usd_total: string | null;
  liquidity_usd_band_100: string | null;
  ratio_band_100: string | null;
};

function isStale(iso: string | null): boolean {
  if (!iso) return true;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return true;
  return Date.now() - t > STALE_MS;
}

function swapMoreInfoHref(bandBps: number) {
  const p = new URLSearchParams({
    dex: "all",
    tokenIn: MON,
    bandBps: String(bandBps),
  });
  return `/swap?${p.toString()}`;
}

export default function DashboardPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<DashboardMetrics | null>(null);
  const [morpho, setMorpho] = useState<MorphoAtRiskResponse | null>(null);
  const [historyRows, setHistoryRows] = useState<HistoryRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      setLoading(true);
      setError(null);
      try {
        const [mRes, moRes, hRes] = await Promise.all([
          fetch("/api/dashboard-metrics"),
          fetch("/api/morpho-at-risk"),
          fetch("/api/dashboard-history?days=30"),
        ]);
        if (!mRes.ok) throw new Error(`dashboard-metrics HTTP ${mRes.status}`);
        const metrics = (await mRes.json()) as DashboardMetrics;
        let moJson: MorphoAtRiskResponse | null = null;
        if (moRes.ok) moJson = (await moRes.json()) as MorphoAtRiskResponse;
        const hJson = hRes.ok ? ((await hRes.json()) as { rows: HistoryRow[] }) : { rows: [] };
        if (!cancelled) {
          setData(metrics);
          setMorpho(moJson);
          setHistoryRows(hJson.rows ?? []);
        }
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load dashboard");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    run();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) return <div style={{ padding: 24 }}>Loading dashboard…</div>;
  if (error) return <div style={{ padding: 24 }}>Error: {error}</div>;
  if (!data) return <div style={{ padding: 24 }}>No data.</div>;

  const band100 = data.bands.find((b) => b.bandBps === 100) ?? data.bands[0];
  const lendStale = isStale(data.latestLendTs);
  const swapStale = isStale(data.latestSwapTs ?? band100?.latestSwapTs ?? null);

  const dexRows = band100
    ? Object.entries(band100.liquidityByDexUsd)
        .map(([dex, usd]) => ({ dex, usd }))
        .sort((a, b) => Number(b.usd) - Number(a.usd))
    : [];

  const morphoHistEntries = morpho?.histogram ? orderedMorphoHistogramEntries(morpho.histogram) : [];
  const morphoHistChartData = morphoHistEntries.map(([k, v]) => ({
    label: MORPHO_HISTOGRAM_LABELS[k] ?? k,
    count: v,
  }));
  const historyChartData = buildHistoryChartData(historyRows);
  const bandChartRows = buildBandChartRows(data.bands);
  const protocolChartRows = buildProtocolChartRows(data.borrowByProtocol);
  const dexChartRows = band100 ? buildDexChartRows(band100.liquidityByDexUsd) : [];

  return (
    <main style={{ padding: 24, maxWidth: 960 }}>
      <h1 style={{ margin: 0, display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
        Dashboard
        <DashboardInfoTip label="Explain what this dashboard shows" text={dashboardTooltips.pageIntro} />
      </h1>
      <p style={{ marginTop: 8, marginBottom: 12, color: "rgba(0,0,0,0.65)", maxWidth: 720 }}>
        MON borrowing safety snapshot: MON/WMON-backed borrows (USD) vs estimated sell-side liquidity (USD) from
        depth snapshots. See <Link href="/methodology">methodology</Link>.
      </p>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16, fontSize: 13 }}>
        <span
          style={{
            padding: "4px 8px",
            borderRadius: 6,
            background: lendStale ? "#fff3cd" : "#e8f5e9",
            display: "inline-flex",
            alignItems: "center",
            gap: 2,
          }}
        >
          Lending data: {data.latestLendTs ?? "—"}
          {lendStale ? " (stale)" : ""}
          <DashboardInfoTip label="Explain lending data timestamp" text={dashboardTooltips.staleLending} />
        </span>
        <span
          style={{
            padding: "4px 8px",
            borderRadius: 6,
            background: swapStale ? "#fff3cd" : "#e8f5e9",
            display: "inline-flex",
            alignItems: "center",
            gap: 2,
          }}
        >
          Swap depth: {data.latestSwapTs ?? band100?.latestSwapTs ?? "—"}
          {swapStale ? " (stale)" : ""}
          <DashboardInfoTip label="Explain swap depth timestamp" text={dashboardTooltips.staleSwap} />
        </span>
      </div>

      <section style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
        <article style={{ border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
          <div style={{ fontSize: 12, opacity: 0.7, display: "flex", alignItems: "center", gap: 2, flexWrap: "wrap" }}>
            Borrowed (MON + WMON collateral, USD)
            <DashboardInfoTip label="Explain borrowed total" text={dashboardTooltips.borrowedCard} />
          </div>
          <div style={{ fontSize: 28, fontWeight: 800, marginTop: 6 }}>${formatDepthNumber(data.borrowUsdTotal)}</div>
          <div style={{ marginTop: 10, display: "flex", gap: 12, alignItems: "center" }}>
            <Link href="/lend" style={{ textDecoration: "none" }}>
              More info
            </Link>
          </div>
        </article>

        <article style={{ border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
          <div style={{ fontSize: 12, opacity: 0.7, display: "flex", alignItems: "center", gap: 2, flexWrap: "wrap" }}>
            Liquidity (MON in, all DEXes, ±100 bps, USD est.)
            <DashboardInfoTip label="Explain liquidity estimate" text={dashboardTooltips.liquidityCard} />
          </div>
          <div style={{ fontSize: 28, fontWeight: 800, marginTop: 6 }}>
            ${formatDepthNumber(band100?.liquidityUsdTotal ?? "0")}
          </div>
          <div
            style={{
              fontSize: 13,
              marginTop: 6,
              opacity: 0.75,
              display: "flex",
              alignItems: "center",
              gap: 4,
              flexWrap: "wrap",
            }}
          >
            Safety ratio (borrow ÷ liquidity):{" "}
            <strong>{band100?.safetyRatio != null ? formatDepthNumber(band100.safetyRatio) : "—"}</strong>
            <DashboardInfoTip label="Explain safety ratio" text={dashboardTooltips.safetyRatio} />
          </div>
          <div style={{ marginTop: 10 }}>
            <Link href={swapMoreInfoHref(100)} style={{ textDecoration: "none" }}>
              More info
            </Link>
          </div>
        </article>
      </section>

      <section style={{ marginTop: 24 }}>
        <h2 style={{ margin: 0, marginBottom: 10, fontSize: 18, display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
          Stress by price band
          <DashboardInfoTip label="Explain price bands" text={dashboardTooltips.stressBands} />
        </h2>
        {bandChartRows.length > 0 ? (
          <div
            style={{
              marginBottom: 12,
              padding: "12px 12px 4px",
              border: "1px solid #e5e5e5",
              borderRadius: 10,
              background: "#fafafa",
            }}
          >
            <h3
              style={{
                margin: "0 0 8px 0",
                fontSize: 14,
                fontWeight: 600,
                display: "flex",
                alignItems: "center",
                gap: 4,
                flexWrap: "wrap",
              }}
            >
              Chart
              <DashboardInfoTip label="Explain stress band chart" text={dashboardTooltips.chartStressBands} />
            </h3>
            <BandsLiquidityChart rows={bandChartRows} />
          </div>
        ) : null}
        <div style={{ border: "1px solid #e5e5e5", borderRadius: 10, overflow: "hidden" }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "auto 1fr 1fr 1fr",
              gap: 8,
              padding: "10px 12px",
              background: "#f5f5f5",
              fontWeight: 700,
              fontSize: 13,
            }}
          >
            <div>Band (bps)</div>
            <div>Liquidity USD</div>
            <div>Ratio</div>
            <div>Swap</div>
          </div>
          {data.bands.map((b) => (
            <div
              key={b.bandBps}
              style={{
                display: "grid",
                gridTemplateColumns: "auto 1fr 1fr 1fr",
                gap: 8,
                padding: "10px 12px",
                borderTop: "1px solid #efefef",
                fontSize: 14,
                alignItems: "center",
              }}
            >
              <div>{b.bandBps}</div>
              <div style={{ fontFamily: "monospace" }}>${formatDepthNumber(b.liquidityUsdTotal)}</div>
              <div style={{ fontFamily: "monospace" }}>{b.safetyRatio != null ? formatDepthNumber(b.safetyRatio) : "—"}</div>
              <div>
                <Link href={swapMoreInfoHref(b.bandBps)} style={{ fontSize: 13 }}>
                  Open
                </Link>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section style={{ marginTop: 24 }}>
        <h2 style={{ margin: 0, marginBottom: 10, fontSize: 18, display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
          Morpho borrower health (MON/WMON collateral markets)
          <DashboardInfoTip label="Explain Morpho borrower health" text={dashboardTooltips.morphoSection} />
        </h2>
        <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 10 }}>
          From Morpho Blue API per-position fields. Snapshot: {morpho?.latestTs ?? "—"} · Positions:{" "}
          {morpho?.positionCount ?? 0}
        </p>
        {!morpho?.histogram ? (
          <div style={{ padding: 12, border: "1px solid #eee", borderRadius: 8, opacity: 0.7 }}>
            No Morpho rollup in database yet (run indexer after deploy).
          </div>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "stretch" }}>
            <div
              style={{
                flex: "1 1 300px",
                minWidth: 0,
                padding: "12px 12px 4px",
                border: "1px solid #e5e5e5",
                borderRadius: 10,
                background: "#fafafa",
              }}
            >
              <h3
                style={{
                  margin: "0 0 8px 0",
                  fontSize: 14,
                  fontWeight: 600,
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  flexWrap: "wrap",
                }}
              >
                Distribution
                <DashboardInfoTip label="Explain Morpho histogram chart" text={dashboardTooltips.chartMorphoDistribution} />
              </h3>
              <MorphoHistogramChart data={morphoHistChartData} />
            </div>
            <div style={{ flex: "1 1 220px", minWidth: 0, border: "1px solid #e5e5e5", borderRadius: 10, overflow: "hidden" }}>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr auto",
                  padding: "10px 12px",
                  background: "#f5f5f5",
                  fontWeight: 700,
                }}
              >
                <div>Health factor band</div>
                <div>Count</div>
              </div>
              {morphoHistEntries.map(([k, v]) => (
                <div
                  key={k}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr auto",
                    padding: "10px 12px",
                    borderTop: "1px solid #efefef",
                  }}
                >
                  <div>{MORPHO_HISTOGRAM_LABELS[k] ?? k}</div>
                  <div style={{ fontFamily: "monospace" }}>{v}</div>
                </div>
              ))}
            </div>
          </div>
        )}
        {morpho && morpho.topPositions && morpho.topPositions.length > 0 ? (
          <div style={{ marginTop: 14 }}>
            <h3 style={{ fontSize: 15, margin: "0 0 8px 0" }}>Closest positions (lowest HF)</h3>
            <div style={{ overflowX: "auto", border: "1px solid #e5e5e5", borderRadius: 8 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ background: "#f5f5f5", textAlign: "left" }}>
                    <th style={{ padding: 8 }}>User</th>
                    <th style={{ padding: 8 }}>Loan</th>
                    <th style={{ padding: 8 }}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        HF
                        <DashboardInfoTip label="Explain health factor" text={dashboardTooltips.morphoHfColumn} />
                      </span>
                    </th>
                    <th style={{ padding: 8 }}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        Price Δ to liq.
                        <DashboardInfoTip
                          label="Explain price move to liquidation"
                          text={dashboardTooltips.morphoPriceVarColumn}
                        />
                      </span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {morpho.topPositions.slice(0, 15).map((p, i) => (
                    <tr key={`${p.user}-${i}`} style={{ borderTop: "1px solid #eee" }}>
                      <td style={{ padding: 8, fontFamily: "monospace", fontSize: 12 }}>{p.user ?? "—"}</td>
                      <td style={{ padding: 8 }}>{p.loanSymbol ?? "—"}</td>
                      <td style={{ padding: 8 }}>{p.healthFactor != null ? formatDepthNumber(p.healthFactor) : "—"}</td>
                      <td style={{ padding: 8 }}>
                        {p.priceVariationToLiquidationPrice != null
                          ? formatDepthNumber(p.priceVariationToLiquidationPrice)
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </section>

      <section style={{ marginTop: 24 }}>
        <h2 style={{ margin: 0, marginBottom: 10, fontSize: 18, display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
          Daily history (UTC)
          <DashboardInfoTip label="Explain daily history table" text={dashboardTooltips.dailyHistory} />
        </h2>
        {historyRows.length === 0 ? (
          <div style={{ padding: 12, opacity: 0.7 }}>No rollup rows yet.</div>
        ) : (
          <>
            <div
              style={{
                marginBottom: 12,
                padding: "12px 12px 4px",
                border: "1px solid #e5e5e5",
                borderRadius: 10,
                background: "#fafafa",
              }}
            >
              <h3
                style={{
                  margin: "0 0 8px 0",
                  fontSize: 14,
                  fontWeight: 600,
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  flexWrap: "wrap",
                }}
              >
                Trend
                <DashboardInfoTip label="Explain daily history chart" text={dashboardTooltips.chartHistoryTrend} />
              </h3>
              <HistoryBorrowLiquidityChart data={historyChartData} />
            </div>
            <div style={{ border: "1px solid #e5e5e5", borderRadius: 10, overflow: "hidden" }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "auto 1fr 1fr 1fr",
                gap: 8,
                padding: "10px 12px",
                background: "#f5f5f5",
                fontWeight: 700,
                fontSize: 13,
              }}
            >
              <div>Day</div>
              <div>Borrow USD</div>
              <div>Liq. ±100 bps</div>
              <div>Ratio</div>
            </div>
            {historyRows.map((r) => (
              <div
                key={r.day}
                style={{
                  display: "grid",
                  gridTemplateColumns: "auto 1fr 1fr 1fr",
                  gap: 8,
                  padding: "10px 12px",
                  borderTop: "1px solid #efefef",
                  fontSize: 13,
                }}
              >
                <div>{r.day}</div>
                <div style={{ fontFamily: "monospace" }}>${formatDepthNumber(r.borrow_usd_total ?? "0")}</div>
                <div style={{ fontFamily: "monospace" }}>${formatDepthNumber(r.liquidity_usd_band_100 ?? "0")}</div>
                <div style={{ fontFamily: "monospace" }}>
                  {r.ratio_band_100 != null ? formatDepthNumber(r.ratio_band_100) : "—"}
                </div>
              </div>
            ))}
          </div>
          </>
        )}
      </section>

      <section style={{ marginTop: 24 }}>
        <h2 style={{ margin: 0, marginBottom: 10, fontSize: 18, display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
          Borrow by protocol
          <DashboardInfoTip label="Explain borrow by protocol" text={dashboardTooltips.borrowByProtocol} />
        </h2>
        {protocolChartRows.length > 0 ? (
          <div
            style={{
              marginBottom: 12,
              padding: "12px 12px 4px",
              border: "1px solid #e5e5e5",
              borderRadius: 10,
              background: "#fafafa",
            }}
          >
            <h3
              style={{
                margin: "0 0 8px 0",
                fontSize: 14,
                fontWeight: 600,
                display: "flex",
                alignItems: "center",
                gap: 4,
                flexWrap: "wrap",
              }}
            >
              Chart
              <DashboardInfoTip label="Explain borrow by protocol chart" text={dashboardTooltips.chartBorrowProtocol} />
            </h3>
            <BorrowByProtocolChart rows={protocolChartRows} />
          </div>
        ) : null}
        <div style={{ border: "1px solid #e5e5e5", borderRadius: 10, overflow: "hidden" }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr auto",
              padding: "10px 12px",
              background: "#f5f5f5",
              fontWeight: 700,
            }}
          >
            <div>Protocol</div>
            <div>USD</div>
          </div>
          {data.borrowByProtocol.length === 0 ? (
            <div style={{ padding: 12, opacity: 0.65 }}>No lending snapshot rows.</div>
          ) : (
            data.borrowByProtocol.map((row) => (
              <div
                key={row.protocol}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr auto",
                  padding: "10px 12px",
                  borderTop: "1px solid #efefef",
                }}
              >
                <div>{row.protocol}</div>
                <div style={{ fontFamily: "monospace" }}>${formatDepthNumber(row.usd)}</div>
              </div>
            ))
          )}
        </div>
      </section>

      <section style={{ marginTop: 24 }}>
        <h2 style={{ margin: 0, marginBottom: 10, fontSize: 18, display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
          Liquidity by DEX (±100 bps, USD est.)
          <DashboardInfoTip label="Explain liquidity by DEX" text={dashboardTooltips.liquidityByDex} />
        </h2>
        {dexChartRows.length > 0 ? (
          <div
            style={{
              marginBottom: 12,
              padding: "12px 12px 4px",
              border: "1px solid #e5e5e5",
              borderRadius: 10,
              background: "#fafafa",
            }}
          >
            <h3
              style={{
                margin: "0 0 8px 0",
                fontSize: 14,
                fontWeight: 600,
                display: "flex",
                alignItems: "center",
                gap: 4,
                flexWrap: "wrap",
              }}
            >
              Chart
              <DashboardInfoTip label="Explain liquidity by DEX chart" text={dashboardTooltips.chartDexLiquidity} />
            </h3>
            <DexLiquidityChart rows={dexChartRows} />
          </div>
        ) : null}
        <div style={{ border: "1px solid #e5e5e5", borderRadius: 10, overflow: "hidden" }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr auto",
              padding: "10px 12px",
              background: "#f5f5f5",
              fontWeight: 700,
            }}
          >
            <div>DEX</div>
            <div>Liquidity USD</div>
          </div>
          {dexRows.length === 0 ? (
            <div style={{ padding: 12, opacity: 0.65 }}>No swap depth rows for this band.</div>
          ) : (
            dexRows.map((row) => (
              <div
                key={row.dex}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr auto",
                  padding: "10px 12px",
                  borderTop: "1px solid #efefef",
                }}
              >
                <div>{row.dex}</div>
                <div style={{ fontFamily: "monospace" }}>${formatDepthNumber(row.usd)}</div>
              </div>
            ))
          )}
        </div>
      </section>
    </main>
  );
}
