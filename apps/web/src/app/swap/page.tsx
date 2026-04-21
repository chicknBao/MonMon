"use client";

import { useEffect, useMemo, useState } from "react";

const MON = "0x0000000000000000000000000000000000000000";
const USDC = "0x754704bc059f8c67012fed69bc8a327a5aafb603";
const AUSD = "0x00000000efe302beaa2b3e6e1b18d08d69a9012a";

const tokenInOptions = [
  { address: MON, symbol: "MON", decimalsHint: 18 },
  { address: USDC, symbol: "USDC", decimalsHint: 6 },
  { address: AUSD, symbol: "AUSD", decimalsHint: 6 },
];

const bandOptions = [25, 50, 100, 200, 500];
const dexOptions = ["uniswap_v3", "uniswap_v4", "curve", "balancer", "lfj", "pancake", "all"] as const;

type TotalRow = {
  tokenOut: string;
  symbol: string;
  name?: string;
  decimals: number;
  depthSimple: string;
  depthBand: string;
};

type PoolRow = {
  dex: string;
  poolAddress: string;
  tokenOut: string;
  symbol: string;
  name?: string;
  decimals: number;
  depthSimple: string;
  depthBand: string;
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

  if (abs < 1e-6) {
    const cap = "0.000001";
    return n < 0 ? `-${cap}`.replace("-", "-") : `<${cap}`;
  }

  const maxFractionDigits = abs >= 1 ? 6 : abs >= 0.1 ? 6 : abs >= 0.01 ? 7 : abs >= 0.001 ? 8 : 9;
  const formatted = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: maxFractionDigits,
  }).format(n);
  return formatted.replace(/(\.\d*?[1-9])0+$/g, "$1").replace(/\.0+$/g, "");
}

export default function SwapPage() {
  const [dex, setDex] = useState<string>("uniswap_v3");
  const [bandBps, setBandBps] = useState<number>(100);
  const [tokenIn, setTokenIn] = useState<string>(MON);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [totals, setTotals] = useState<TotalRow[]>([]);
  const [pools, setPools] = useState<PoolRow[]>([]);
  const [latestTs, setLatestTs] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const sp = new URLSearchParams(window.location.search);
    const d = sp.get("dex");
    if (d && (dexOptions as readonly string[]).includes(d)) setDex(d);
    const ti = sp.get("tokenIn");
    if (ti) {
      const lower = ti.toLowerCase();
      const match = tokenInOptions.find((x) => x.address.toLowerCase() === lower);
      if (match) setTokenIn(match.address);
    }
    const bb = sp.get("bandBps");
    if (bb) {
      const n = Number(bb);
      if (Number.isFinite(n) && bandOptions.includes(n)) setBandBps(n);
    }
  }, []);

  const queryUrl = useMemo(() => {
    const limitTokens = dex === "all" ? "100" : "20";
    const limitPools = dex === "all" ? "200" : "50";
    const params = new URLSearchParams({
      dex,
      tokenIn,
      bandBps: String(bandBps),
      limitTokens,
      limitPools,
    });
    return `/api/top-swap-outputs?${params.toString()}`;
  }, [bandBps, dex, tokenIn]);

  useEffect(() => {
    setTotals([]);
    setPools([]);
    setLatestTs(null);
    setLoadError(null);

    fetch(queryUrl)
      .then(async (r) => {
        if (!r.ok) {
          const payload = await r.json().catch(() => ({}));
          const message = typeof payload?.error === "string" ? payload.error : `Request failed (${r.status})`;
          throw new Error(message);
        }
        return r.json();
      })
      .then((data: any) => {
        setLatestTs(data.latestTs ?? null);
        setTotals(data.totals ?? []);
        setPools(data.pools ?? []);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : "Failed to load data";
        setLoadError(message);
      });
  }, [queryUrl]);

  return (
    <main className="pageMain">
      <h1 style={{ margin: 0, marginBottom: "var(--space-4)" }}>Swap Depth (Max Output)</h1>

      <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
        <label style={{ display: "flex", flexDirection: "column", fontSize: 12 }}>
          DEX
          <select value={dex} onChange={(e) => setDex(e.target.value)} style={{ padding: 8 }}>
            {dexOptions.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>

        <label style={{ display: "flex", flexDirection: "column", fontSize: 12 }}>
          Band (bps)
          <select value={bandBps} onChange={(e) => setBandBps(Number(e.target.value))} style={{ padding: 8 }}>
            {bandOptions.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>

        <label style={{ display: "flex", flexDirection: "column", fontSize: 12 }}>
          tokenIn (sell collateral)
          <select
            value={tokenIn}
            onChange={(e) => setTokenIn(e.target.value)}
            style={{ padding: 8 }}
          >
            {tokenInOptions.map((t) => (
              <option key={t.address} value={t.address}>
                {t.symbol}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="pageMuted" style={{ marginBottom: "var(--space-5)", marginTop: "var(--space-2)" }}>
        Max output within the ±{bandBps / 100}% price band (directional, per pool). Totals sum across pools.
      </div>
      {loadError ? (
        <div style={{ color: "var(--color-error)", marginBottom: "var(--space-3)" }}>
          API error: {loadError}
        </div>
      ) : null}

      <section style={{ marginTop: "var(--space-4)" }}>
        <h2 style={{ margin: 0, marginBottom: "var(--space-2)" }}>Total max output across pools</h2>
        <div className="pageTableShell">
          <table className="dataTable">
            <thead>
              <tr>
                <th>TokenOut</th>
                <th className="dataTableNum">Max Output</th>
              </tr>
            </thead>
            <tbody>
              {totals.length === 0 ? (
                <tr>
                  <td colSpan={2} className="pageMuted" style={{ padding: "var(--space-2)" }}>
                    No data for the latest snapshot.
                  </td>
                </tr>
              ) : (
                totals.map((t) => (
                  <tr key={t.tokenOut}>
                    <td style={{ padding: "var(--space-2)" }}>
                      <span style={{ fontWeight: 500 }}>{t.symbol}</span>
                      {t.name && t.name !== t.symbol ? (
                        <span className="pageMuted" style={{ display: "block", fontSize: 12 }}>
                          {t.name}
                        </span>
                      ) : null}
                      <span
                        className="pageMuted"
                        style={{ fontFamily: "var(--font-mono)", fontSize: 12, display: "block" }}
                      >
                        {t.tokenOut.slice(0, 6)}…{t.tokenOut.slice(-4)}
                      </span>
                    </td>
                    <td className="dataTableNum">{formatDepthNumber(t.depthBand)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="pageMuted" style={{ marginTop: "var(--space-2)", fontFamily: "var(--font-mono)", fontSize: 13 }}>
          latestTs: {latestTs ?? "null"}
        </div>
      </section>

      <section style={{ marginTop: "var(--space-6)" }}>
        <h2 style={{ margin: 0, marginBottom: "var(--space-2)" }}>Top pools by max output</h2>
        <div className="pageTableShell">
          <table className="dataTable">
            <thead>
              <tr>
                <th>Pool</th>
                <th>TokenOut</th>
                <th className="dataTableNum">Max Output</th>
              </tr>
            </thead>
            <tbody>
              {pools.length === 0 ? (
                <tr>
                  <td colSpan={3} className="pageMuted" style={{ padding: "var(--space-2)" }}>
                    No pool rows yet.
                  </td>
                </tr>
              ) : (
                pools.map((p, idx) => (
                  <tr key={`${p.poolAddress}-${idx}`}>
                    <td style={{ padding: "var(--space-2)", fontFamily: "var(--font-mono)", fontSize: 13 }}>
                      {p.dex} {p.poolAddress.slice(0, 6)}…{p.poolAddress.slice(-4)}
                    </td>
                    <td style={{ padding: "var(--space-2)" }}>
                      <span style={{ fontWeight: 500 }}>{p.symbol}</span>
                      {p.name && p.name !== p.symbol ? (
                        <span className="pageMuted" style={{ display: "block", fontSize: 12 }}>
                          {p.name}
                        </span>
                      ) : null}
                      <span
                        className="pageMuted"
                        style={{ fontFamily: "var(--font-mono)", fontSize: 12, display: "block" }}
                      >
                        {p.tokenOut.slice(0, 6)}…{p.tokenOut.slice(-4)}
                      </span>
                    </td>
                    <td className="dataTableNum">{formatDepthNumber(p.depthBand)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

