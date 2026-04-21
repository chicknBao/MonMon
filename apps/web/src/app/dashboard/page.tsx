"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { CollapsibleSection } from "../../components/CollapsibleSection";
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
  normalizeMorphoHistogram,
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
  /** New shape: `{ count, borrowUsd }` per key; legacy: number counts only. */
  histogram: Record<string, unknown> | null;
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

const grid4 = { gridTemplateColumns: "auto 1fr 1fr 1fr" } as const;
const grid2 = { gridTemplateColumns: "1fr auto" } as const;
const gridMorphoHist = { gridTemplateColumns: "1fr auto auto" } as const;

export default function DashboardPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<DashboardMetrics | null>(null);
  const [morpho, setMorpho] = useState<MorphoAtRiskResponse | null>(null);
  const [historyRows, setHistoryRows] = useState<HistoryRow[]>([]);
  const [historyExpanded, setHistoryExpanded] = useState(false);

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

  const historySortedDesc = useMemo(
    () => [...historyRows].sort((a, b) => b.day.localeCompare(a.day)),
    [historyRows],
  );
  const historyVisibleRows = historyExpanded ? historySortedDesc : historySortedDesc.slice(0, 7);
  const historyHasMore = historySortedDesc.length > 7;

  if (loading) {
    return (
      <div className="pageMain" style={{ color: "var(--color-text-muted)" }}>
        Loading dashboard…
      </div>
    );
  }
  if (error) {
    return (
      <div className="pageMain" style={{ color: "var(--color-error)" }}>
        Error: {error}
      </div>
    );
  }
  if (!data) {
    return <div className="pageMain">No data.</div>;
  }

  const band100 = data.bands.find((b) => b.bandBps === 100) ?? data.bands[0];
  const lendStale = isStale(data.latestLendTs);
  const swapStale = isStale(data.latestSwapTs ?? band100?.latestSwapTs ?? null);

  const dexRows = band100
    ? Object.entries(band100.liquidityByDexUsd)
        .map(([dex, usd]) => ({ dex, usd }))
        .sort((a, b) => Number(b.usd) - Number(a.usd))
    : [];

  const morphoHistNormalized = normalizeMorphoHistogram(morpho?.histogram ?? null);
  const morphoHistEntries = morphoHistNormalized ? orderedMorphoHistogramEntries(morphoHistNormalized) : [];
  const morphoHistChartData = morphoHistEntries.map(([k, s]) => ({
    label: MORPHO_HISTOGRAM_LABELS[k] ?? k,
    count: s.count,
  }));
  const historyChartData = buildHistoryChartData(historyRows);
  const bandChartRows = buildBandChartRows(data.bands);
  const protocolChartRows = buildProtocolChartRows(data.borrowByProtocol);
  const dexChartRows = band100 ? buildDexChartRows(band100.liquidityByDexUsd) : [];

  return (
    <main className="dashboardMain">
      <section className="dashboardTierFirst">
        <h1
          className="dashboardSectionTitle"
          style={{ marginBottom: 0, fontSize: "clamp(1.35rem, 2.5vw, 1.65rem)" }}
        >
          Dashboard
          <DashboardInfoTip label="Explain what this dashboard shows" text={dashboardTooltips.pageIntro} />
        </h1>
        <p className="dashboardLead">
          MON borrowing safety snapshot: MON/WMON-backed borrows (USD) vs estimated sell-side liquidity (USD) from depth
          snapshots. See <Link href="/methodology">methodology</Link>.
        </p>

        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)", marginBottom: "var(--space-4)" }}>
          <span className={`dashboardPill ${lendStale ? "dashboardPillStale" : "dashboardPillFresh"}`}>
            Lending data: {data.latestLendTs ?? "—"}
            {lendStale ? " (stale)" : ""}
            <DashboardInfoTip label="Explain lending data timestamp" text={dashboardTooltips.staleLending} />
          </span>
          <span className={`dashboardPill ${swapStale ? "dashboardPillStale" : "dashboardPillFresh"}`}>
            Swap depth: {data.latestSwapTs ?? band100?.latestSwapTs ?? "—"}
            {swapStale ? " (stale)" : ""}
            <DashboardInfoTip label="Explain swap depth timestamp" text={dashboardTooltips.staleSwap} />
          </span>
        </div>

        <div className="dashboardKpiGrid">
          <article className="dashboardCard">
            <div className="dashboardKpiLabel">
              Borrowed (MON + WMON collateral, USD)
              <DashboardInfoTip label="Explain borrowed total" text={dashboardTooltips.borrowedCard} />
            </div>
            <div className="dashboardKpiValue">${formatDepthNumber(data.borrowUsdTotal)}</div>
            <div style={{ marginTop: "var(--space-3)", display: "flex", gap: "var(--space-3)", alignItems: "center" }}>
              <Link href="/lend" className="dashboardCardLink">
                More info
              </Link>
            </div>
          </article>

          <article className="dashboardCard">
            <div className="dashboardKpiLabel">
              Liquidity (MON in, all DEXes, ±100 bps, USD est.)
              <DashboardInfoTip label="Explain liquidity estimate" text={dashboardTooltips.liquidityCard} />
            </div>
            <div className="dashboardKpiValue">${formatDepthNumber(band100?.liquidityUsdTotal ?? "0")}</div>
            <div className="dashboardKpiMeta">
              Safety ratio (borrow ÷ liquidity):{" "}
              <strong>{band100?.safetyRatio != null ? formatDepthNumber(band100.safetyRatio) : "—"}</strong>
              <DashboardInfoTip label="Explain safety ratio" text={dashboardTooltips.safetyRatio} />
            </div>
            <div style={{ marginTop: "var(--space-3)" }}>
              <Link href={swapMoreInfoHref(100)} className="dashboardCardLink">
                More info
              </Link>
            </div>
          </article>
        </div>
      </section>

      <div className="dashboardTier">
        <p className="dashboardTierLabel">Liquidity and stress</p>

        <section>
          <h2 className="dashboardSectionTitle">
            Stress by price band
            <DashboardInfoTip label="Explain price bands" text={dashboardTooltips.stressBands} />
          </h2>
          {bandChartRows.length > 0 ? (
            <div className="dashboardChartPanel">
              <h3 className="dashboardChartTitle">
                Chart
                <DashboardInfoTip label="Explain stress band chart" text={dashboardTooltips.chartStressBands} />
              </h3>
              <BandsLiquidityChart rows={bandChartRows} />
            </div>
          ) : null}
          <div className="dashboardTableShell">
            <div className="dashboardTableHeader" style={grid4}>
              <div>Band (bps)</div>
              <div className="dashboardNum">Liquidity USD</div>
              <div className="dashboardNum">Ratio</div>
              <div>Swap</div>
            </div>
            {data.bands.map((b) => (
              <div key={b.bandBps} className="dashboardTableRow" style={grid4}>
                <div>{b.bandBps}</div>
                <div className="dashboardNum">${formatDepthNumber(b.liquidityUsdTotal)}</div>
                <div className="dashboardNum">{b.safetyRatio != null ? formatDepthNumber(b.safetyRatio) : "—"}</div>
                <div>
                  <Link href={swapMoreInfoHref(b.bandBps)} style={{ fontSize: 13 }}>
                    Open
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section style={{ marginTop: "var(--space-6)" }}>
          <h2 className="dashboardSectionTitle">
            Daily history (UTC)
            <DashboardInfoTip label="Explain daily history table" text={dashboardTooltips.dailyHistory} />
          </h2>
          {historyRows.length === 0 ? (
            <div className="dashboardEmpty">No rollup rows yet.</div>
          ) : (
            <>
              <div className="dashboardChartPanel">
                <h3 className="dashboardChartTitle">
                  Trend
                  <DashboardInfoTip label="Explain daily history chart" text={dashboardTooltips.chartHistoryTrend} />
                </h3>
                <HistoryBorrowLiquidityChart data={historyChartData} />
              </div>
              <div className="dashboardTableShell">
                <div className="dashboardTableHeader dashboardTableRowCompact" style={grid4}>
                  <div>Day</div>
                  <div className="dashboardNum">Borrow USD</div>
                  <div className="dashboardNum">Liq. ±100 bps</div>
                  <div className="dashboardNum">Ratio</div>
                </div>
                {historyVisibleRows.map((r) => (
                  <div key={r.day} className="dashboardTableRow dashboardTableRowCompact" style={grid4}>
                    <div>{r.day}</div>
                    <div className="dashboardNum">${formatDepthNumber(r.borrow_usd_total ?? "0")}</div>
                    <div className="dashboardNum">${formatDepthNumber(r.liquidity_usd_band_100 ?? "0")}</div>
                    <div className="dashboardNum">
                      {r.ratio_band_100 != null ? formatDepthNumber(r.ratio_band_100) : "—"}
                    </div>
                  </div>
                ))}
              </div>
              {historyHasMore ? (
                <div className="historyToggle">
                  <button
                    type="button"
                    className="historyToggleBtn"
                    onClick={() => setHistoryExpanded((e) => !e)}
                  >
                    {historyExpanded ? "Show fewer rows" : `Show all (${historySortedDesc.length} days)`}
                  </button>
                </div>
              ) : null}
            </>
          )}
        </section>
      </div>

      <div className="dashboardTier">
        <p className="dashboardTierLabel">Attribution</p>
        <div className="attributionGrid">
          <div>
            <h3 className="dashboardSubsectionTitle">
              Borrow by protocol
              <DashboardInfoTip label="Explain borrow by protocol" text={dashboardTooltips.borrowByProtocol} />
            </h3>
            {protocolChartRows.length > 0 ? (
              <div className="dashboardChartPanel">
                <h4 className="dashboardChartTitle" style={{ fontSize: 13 }}>
                  Chart
                  <DashboardInfoTip label="Explain borrow by protocol chart" text={dashboardTooltips.chartBorrowProtocol} />
                </h4>
                <BorrowByProtocolChart rows={protocolChartRows} />
              </div>
            ) : null}
            <div className="dashboardTableShell">
              <div className="dashboardTableHeader" style={grid2}>
                <div>Protocol</div>
                <div className="dashboardNum">USD</div>
              </div>
              {data.borrowByProtocol.length === 0 ? (
                <div className="dashboardEmpty">No lending snapshot rows.</div>
              ) : (
                data.borrowByProtocol.map((row) => (
                  <div key={row.protocol} className="dashboardTableRow" style={grid2}>
                    <div>{row.protocol}</div>
                    <div className="dashboardNum">${formatDepthNumber(row.usd)}</div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div>
            <h3 className="dashboardSubsectionTitle">
              Liquidity by DEX (±100 bps, USD est.)
              <DashboardInfoTip label="Explain liquidity by DEX" text={dashboardTooltips.liquidityByDex} />
            </h3>
            {dexChartRows.length > 0 ? (
              <div className="dashboardChartPanel">
                <h4 className="dashboardChartTitle" style={{ fontSize: 13 }}>
                  Chart
                  <DashboardInfoTip label="Explain liquidity by DEX chart" text={dashboardTooltips.chartDexLiquidity} />
                </h4>
                <DexLiquidityChart rows={dexChartRows} />
              </div>
            ) : null}
            <div className="dashboardTableShell">
              <div className="dashboardTableHeader" style={grid2}>
                <div>DEX</div>
                <div className="dashboardNum">Liquidity USD</div>
              </div>
              {dexRows.length === 0 ? (
                <div className="dashboardEmpty">No swap depth rows for this band.</div>
              ) : (
                dexRows.map((row) => (
                  <div key={row.dex} className="dashboardTableRow" style={grid2}>
                    <div>{row.dex}</div>
                    <div className="dashboardNum">${formatDepthNumber(row.usd)}</div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="dashboardTier">
        <p className="dashboardTierLabel">Morpho detail</p>
        <section>
          <h2 className="dashboardSectionTitle">
            Morpho borrower health (MON/WMON collateral markets)
            <DashboardInfoTip label="Explain Morpho borrower health" text={dashboardTooltips.morphoSection} />
          </h2>
          <p className="dashboardMorphoNote">
            From Morpho Blue API per-position fields. Snapshot: {morpho?.latestTs ?? "—"} · Positions:{" "}
            {morpho?.positionCount ?? 0}
          </p>
          {!morpho?.histogram ? (
            <div className="dashboardEmpty pageCard" style={{ borderRadius: "var(--radius-sm)" }}>
              No Morpho rollup in database yet (run indexer after deploy).
            </div>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-4)", alignItems: "stretch" }}>
              <div className="dashboardChartPanel" style={{ flex: "1 1 300px", minWidth: 0 }}>
                <h3 className="dashboardChartTitle">
                  Distribution
                  <DashboardInfoTip
                    label="Explain Morpho histogram chart"
                    text={dashboardTooltips.chartMorphoDistribution}
                  />
                </h3>
                <MorphoHistogramChart data={morphoHistChartData} />
              </div>
              <div className="dashboardTableShell" style={{ flex: "1 1 280px", minWidth: 0 }}>
                <div className="dashboardTableHeader" style={gridMorphoHist}>
                  <div>Health factor band</div>
                  <div className="dashboardNum">Positions</div>
                  <div className="dashboardNum">
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                        justifyContent: "flex-end",
                      }}
                    >
                      Borrow (USD)
                      <DashboardInfoTip
                        label="Explain borrow USD per HF band"
                        text={dashboardTooltips.morphoHistogramBorrowUsd}
                      />
                    </span>
                  </div>
                </div>
                {morphoHistEntries.map(([k, s]) => (
                  <div key={k} className="dashboardTableRow" style={gridMorphoHist}>
                    <div>{MORPHO_HISTOGRAM_LABELS[k] ?? k}</div>
                    <div className="dashboardNum">{s.count}</div>
                    <div className="dashboardNum">${formatDepthNumber(s.borrowUsd)}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {morpho && morpho.topPositions && morpho.topPositions.length > 0 ? (
            <CollapsibleSection id="morpho-positions" title="Closest positions (lowest HF)" defaultOpen={false}>
              <div style={{ overflowX: "auto" }} className="dashboardTableShell">
                <table className="dataTable">
                  <thead>
                    <tr>
                      <th>User</th>
                      <th>Loan</th>
                      <th className="dataTableNum">
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, justifyContent: "flex-end" }}>
                          HF
                          <DashboardInfoTip label="Explain health factor" text={dashboardTooltips.morphoHfColumn} />
                        </span>
                      </th>
                      <th className="dataTableNum">
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, justifyContent: "flex-end" }}>
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
                      <tr key={`${p.user}-${i}`}>
                        <td style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{p.user ?? "—"}</td>
                        <td>{p.loanSymbol ?? "—"}</td>
                        <td className="dataTableNum">
                          {p.healthFactor != null ? formatDepthNumber(p.healthFactor) : "—"}
                        </td>
                        <td className="dataTableNum">
                          {p.priceVariationToLiquidationPrice != null
                            ? formatDepthNumber(p.priceVariationToLiquidationPrice)
                            : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CollapsibleSection>
          ) : null}
        </section>
      </div>
    </main>
  );
}
