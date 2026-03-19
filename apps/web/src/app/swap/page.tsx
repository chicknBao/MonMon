"use client";

import { useEffect, useMemo, useState } from "react";

const WMON = "0x3bd359c1119da7da1d913d1c4d2b7c461115433a";
const USDC = "0x754704bc059f8c67012fed69bc8a327a5aafb603";
const AUSD = "0x00000000efe302beaa2b3e6e1b18d08d69a9012a";

const tokenInOptions = [
  { address: WMON, symbol: "WMON", decimalsHint: 18 },
  { address: USDC, symbol: "USDC", decimalsHint: 6 },
  { address: AUSD, symbol: "AUSD", decimalsHint: 18 },
];

const bandOptions = [50, 100, 200];
const dexOptions = ["uniswap_v3", "curve", "balancer", "lfj", "all"] as const;

type TotalRow = {
  tokenOut: string;
  symbol: string;
  decimals: number;
  depthSimple: string;
  depthBand: string;
};

type PoolRow = {
  dex: string;
  poolAddress: string;
  tokenOut: string;
  symbol: string;
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
  const [tokenIn, setTokenIn] = useState<string>(WMON);

  const [totals, setTotals] = useState<TotalRow[]>([]);
  const [pools, setPools] = useState<PoolRow[]>([]);
  const [latestTs, setLatestTs] = useState<string | null>(null);

  const queryUrl = useMemo(() => {
    const params = new URLSearchParams({
      dex,
      tokenIn,
      bandBps: String(bandBps),
      limitTokens: "20",
      limitPools: "50",
    });
    return `/api/top-swap-outputs?${params.toString()}`;
  }, [bandBps, dex, tokenIn]);

  useEffect(() => {
    setTotals([]);
    setPools([]);
    setLatestTs(null);

    fetch(queryUrl)
      .then((r) => r.json())
      .then((data: any) => {
        setLatestTs(data.latestTs ?? null);
        setTotals(data.totals ?? []);
        setPools(data.pools ?? []);
      })
      .catch(() => undefined);
  }, [queryUrl]);

  return (
    <main style={{ padding: 24 }}>
      <h1 style={{ margin: 0, marginBottom: 16 }}>Swap Depth (Max Output)</h1>

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

      <div style={{ opacity: 0.8, marginBottom: 24, marginTop: 8 }}>
        Max output within the ±{bandBps / 100}% price band (directional, per pool). Totals sum across pools.
      </div>

      <section style={{ marginTop: 16 }}>
        <h2 style={{ margin: 0, marginBottom: 8 }}>Total max output across pools</h2>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 8 }}>TokenOut</th>
              <th style={{ textAlign: "right", borderBottom: "1px solid #ddd", padding: 8 }}>Max Output</th>
            </tr>
          </thead>
          <tbody>
            {totals.length === 0 ? (
              <tr>
                <td colSpan={2} style={{ padding: 8, opacity: 0.7 }}>
                  No data for the latest snapshot.
                </td>
              </tr>
            ) : (
              totals.map((t) => (
                <tr key={t.tokenOut}>
                  <td style={{ padding: 8 }}>
                    {t.symbol}{" "}
                    <span style={{ opacity: 0.6, fontFamily: "monospace" }}>
                      {t.tokenOut.slice(0, 6)}…{t.tokenOut.slice(-4)}
                    </span>
                  </td>
                  <td style={{ padding: 8, textAlign: "right", fontFamily: "monospace" }}>
                    {formatDepthNumber(t.depthBand)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        <div style={{ opacity: 0.7, marginTop: 8, fontFamily: "monospace" }}>
          latestTs: {latestTs ?? "null"}
        </div>
      </section>

      <section style={{ marginTop: 28 }}>
        <h2 style={{ margin: 0, marginBottom: 8 }}>Top pools by max output</h2>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 8 }}>Pool</th>
              <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 8 }}>TokenOut</th>
              <th style={{ textAlign: "right", borderBottom: "1px solid #ddd", padding: 8 }}>Max Output</th>
            </tr>
          </thead>
          <tbody>
            {pools.length === 0 ? (
              <tr>
                <td colSpan={3} style={{ padding: 8, opacity: 0.7 }}>
                  No pool rows yet.
                </td>
              </tr>
            ) : (
              pools.map((p, idx) => (
                <tr key={`${p.poolAddress}-${idx}`}>
                  <td style={{ padding: 8, fontFamily: "monospace" }}>
                    {p.dex} {p.poolAddress.slice(0, 6)}…{p.poolAddress.slice(-4)}
                  </td>
                  <td style={{ padding: 8 }}>
                    {p.symbol}{" "}
                    <span style={{ opacity: 0.6, fontFamily: "monospace" }}>
                      {p.tokenOut.slice(0, 6)}…{p.tokenOut.slice(-4)}
                    </span>
                  </td>
                  <td style={{ padding: 8, textAlign: "right", fontFamily: "monospace" }}>
                    {formatDepthNumber(p.depthBand)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </main>
  );
}

