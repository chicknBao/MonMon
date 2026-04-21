"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

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

function formatDepthNumber(value: string | number) {
  const raw = typeof value === "number" ? String(value) : value;
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  const abs = Math.abs(n);
  if (abs === 0) return "0";

  if (abs >= 1e3) {
    const formatted = new Intl.NumberFormat("en-US", {
      notation: "compact",
      maximumFractionDigits: 2,
      compactDisplay: "short",
    }).format(n);
    return formatted.replace(/([KMBT])$/, (m, p1) => ` ${String(p1).toLowerCase()}`.trim());
  }

  const maxFractionDigits = abs >= 1 ? 6 : abs >= 0.1 ? 6 : abs >= 0.01 ? 7 : abs >= 0.001 ? 8 : 9;
  const formatted = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: maxFractionDigits,
  }).format(n);
  return formatted.replace(/(\.\d*?[1-9])0+$/g, "$1").replace(/\.0+$/g, "");
}

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

const HISTOGRAM_LABELS: Record<string, string> = {
  lt_1: "HF below 1",
  gte_1_lt_1_05: "1.0 – 1.05",
  gte_1_05_lt_1_1: "1.05 – 1.1",
  gte_1_1_lt_1_2: "1.1 – 1.2",
  gte_1_2_lt_1_5: "1.2 – 1.5",
  gte_1_5: "≥ 1.5",
  unknown: "Unknown HF",
};

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

  const histEntries = morpho?.histogram ? Object.entries(morpho.histogram) : [];

  return (
    <main style={{ padding: 24, maxWidth: 960 }}>
      <h1 style={{ margin: 0 }}>Dashboard</h1>
      <p style={{ marginTop: 8, marginBottom: 12, color: "rgba(0,0,0,0.65)", maxWidth: 720 }}>
        MON borrowing safety snapshot: MON/WMON-backed borrows (USD) vs estimated sell-side liquidity (USD) from
        depth snapshots. See <Link href="/methodology">methodology</Link>.
      </p>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16, fontSize: 13 }}>
        <span style={{ padding: "4px 8px", borderRadius: 6, background: lendStale ? "#fff3cd" : "#e8f5e9" }}>
          Lending data: {data.latestLendTs ?? "—"}
          {lendStale ? " (stale)" : ""}
        </span>
        <span style={{ padding: "4px 8px", borderRadius: 6, background: swapStale ? "#fff3cd" : "#e8f5e9" }}>
          Swap depth: {data.latestSwapTs ?? band100?.latestSwapTs ?? "—"}
          {swapStale ? " (stale)" : ""}
        </span>
      </div>

      <section style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
        <article style={{ border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
          <div style={{ fontSize: 12, opacity: 0.7 }}>Borrowed (MON + WMON collateral, USD)</div>
          <div style={{ fontSize: 28, fontWeight: 800, marginTop: 6 }}>${formatDepthNumber(data.borrowUsdTotal)}</div>
          <div style={{ marginTop: 10, display: "flex", gap: 12, alignItems: "center" }}>
            <Link href="/lend" style={{ textDecoration: "none" }}>
              More info
            </Link>
          </div>
        </article>

        <article style={{ border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
          <div style={{ fontSize: 12, opacity: 0.7 }}>Liquidity (MON in, all DEXes, ±100 bps, USD est.)</div>
          <div style={{ fontSize: 28, fontWeight: 800, marginTop: 6 }}>
            ${formatDepthNumber(band100?.liquidityUsdTotal ?? "0")}
          </div>
          <div style={{ fontSize: 13, marginTop: 6, opacity: 0.75 }}>
            Safety ratio (borrow ÷ liquidity):{" "}
            <strong>{band100?.safetyRatio != null ? formatDepthNumber(band100.safetyRatio) : "—"}</strong>
          </div>
          <div style={{ marginTop: 10 }}>
            <Link href={swapMoreInfoHref(100)} style={{ textDecoration: "none" }}>
              More info
            </Link>
          </div>
        </article>
      </section>

      <section style={{ marginTop: 24 }}>
        <h2 style={{ margin: 0, marginBottom: 10, fontSize: 18 }}>Stress by price band</h2>
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
        <h2 style={{ margin: 0, marginBottom: 10, fontSize: 18 }}>Morpho borrower health (MON/WMON collateral markets)</h2>
        <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 10 }}>
          From Morpho Blue API per-position fields. Snapshot: {morpho?.latestTs ?? "—"} · Positions:{" "}
          {morpho?.positionCount ?? 0}
        </p>
        {!morpho?.histogram ? (
          <div style={{ padding: 12, border: "1px solid #eee", borderRadius: 8, opacity: 0.7 }}>
            No Morpho rollup in database yet (run indexer after deploy).
          </div>
        ) : (
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
              <div>Health factor band</div>
              <div>Count</div>
            </div>
            {histEntries.map(([k, v]) => (
              <div
                key={k}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr auto",
                  padding: "10px 12px",
                  borderTop: "1px solid #efefef",
                }}
              >
                <div>{HISTOGRAM_LABELS[k] ?? k}</div>
                <div style={{ fontFamily: "monospace" }}>{v}</div>
              </div>
            ))}
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
                    <th style={{ padding: 8 }}>HF</th>
                    <th style={{ padding: 8 }}>Price Δ to liq.</th>
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
        <h2 style={{ margin: 0, marginBottom: 10, fontSize: 18 }}>Daily history (UTC)</h2>
        {historyRows.length === 0 ? (
          <div style={{ padding: 12, opacity: 0.7 }}>No rollup rows yet.</div>
        ) : (
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
        )}
      </section>

      <section style={{ marginTop: 24 }}>
        <h2 style={{ margin: 0, marginBottom: 10, fontSize: 18 }}>Borrow by protocol</h2>
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
        <h2 style={{ margin: 0, marginBottom: 10, fontSize: 18 }}>Liquidity by DEX (±100 bps, USD est.)</h2>
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
