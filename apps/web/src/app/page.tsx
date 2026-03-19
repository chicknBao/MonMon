"use client";

import { useEffect, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type TopToken = {
  dex: string;
  tokenAddress: string;
  symbol: string;
  depthSimple: string;
  depthBand: string;
  decimals: number;
};

type SeriesPoint = {
  dex: string;
  timestamp: string;
  depthSimple: string;
  depthBand: string;
  symbol: string;
};

export default function Page() {
  const [tokens, setTokens] = useState<TopToken[]>([]);
  const [dex, setDex] = useState<string>("uniswap_v3");
  const [bandBps, setBandBps] = useState<number>(100);
  const [selectedToken, setSelectedToken] = useState<string | null>(null);
  const [series, setSeries] = useState<SeriesPoint[]>([]);

  const bandOptions = [50, 100, 200];
  const dexOptions = ["uniswap_v3", "curve", "balancer", "lfj"];

  function formatDepthNumber(value: string | number) {
    const raw = typeof value === "number" ? String(value) : value;
    const n = Number(raw);
    if (!Number.isFinite(n)) return raw;
    const abs = Math.abs(n);
    if (abs === 0) return "0";

    // Human-friendly compact notation (k/m/b), no scientific "e".
    if (abs >= 1e3) {
      const formatted = new Intl.NumberFormat("en-US", {
        notation: "compact",
        maximumFractionDigits: 2,
        compactDisplay: "short",
      }).format(n);
      return formatted.replace(/([KMBT])$/, (m, p1) => ` ${String(p1).toLowerCase()}`.trim());
    }

    // Small numbers: show decimals with trimming (up to a reasonable cap).
    if (abs < 1e-6) {
      const cap = "0.000001";
      return n < 0 ? `-${cap}`.replace("-", "-") : `<${cap}`;
    }

    const maxFractionDigits = abs >= 1 ? 6 : abs >= 0.1 ? 6 : abs >= 0.01 ? 7 : abs >= 0.001 ? 8 : 9;
    const formatted = new Intl.NumberFormat("en-US", { maximumFractionDigits: maxFractionDigits }).format(n);
    // Trim trailing zeros/decimal point.
    return formatted.replace(/(\.\d*?[1-9])0+$/g, "$1").replace(/\.0+$/g, "");
  }

  useEffect(() => {
    fetch(`/api/top-tokens?dex=${encodeURIComponent(dex)}&bandBps=${bandBps}&limit=50`)
      .then((r) => r.json())
      .then((data: unknown) => {
        const parsed = data as { tokens?: TopToken[] };
        const next = parsed.tokens ?? [];
        setTokens(next);
        setSelectedToken((prev) => {
          if (prev && next.some((t) => t.tokenAddress === prev)) return prev;
          return next[0]?.tokenAddress ?? null;
        });
      })
      .catch(() => undefined);
  }, [dex, bandBps]);

  useEffect(() => {
    if (!selectedToken) {
      setSeries([]);
      return;
    }

    fetch(
      `/api/token-series?dex=${encodeURIComponent(
        dex,
      )}&tokenAddress=${encodeURIComponent(selectedToken)}&bandBps=${bandBps}&limit=200`,
    )
      .then((r) => r.json())
      .then((data: unknown) => {
        const parsed = data as { series?: SeriesPoint[] };
        setSeries(parsed.series ?? []);
      })
      .catch(() => undefined);
  }, [dex, bandBps, selectedToken]);

  return (
    <main style={{ padding: 24 }}>
      <h1 style={{ margin: 0, marginBottom: 16 }}>Monad Liquidity Depth</h1>

      <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
        <label style={{ display: "flex", flexDirection: "column", fontSize: 12 }}>
          DEX
          <select
            value={dex}
            onChange={(e) => setDex((e.target as HTMLSelectElement).value)}
            style={{ padding: 8 }}
          >
            {dexOptions.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>

        <label style={{ display: "flex", flexDirection: "column", fontSize: 12 }}>
          Band (bps)
          <select
            value={bandBps}
            onChange={(e) => setBandBps(Number((e.target as HTMLSelectElement).value))}
            style={{ padding: 8 }}
          >
            {bandOptions.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div style={{ opacity: 0.8, marginBottom: 24, marginTop: 8 }}>
        Data comes from the latest indexer snapshot. Band-based depth is approximate for MVP.
      </div>

      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 8 }}>
              Token
            </th>
            <th style={{ textAlign: "right", borderBottom: "1px solid #ddd", padding: 8 }}>
              DepthSimple
            </th>
            <th style={{ textAlign: "right", borderBottom: "1px solid #ddd", padding: 8 }}>
              DepthBand
            </th>
          </tr>
        </thead>
        <tbody>
          {tokens.map((t) => (
            <tr key={t.tokenAddress} style={{ cursor: "pointer" }}>
              <td style={{ padding: 8 }}>
                <button
                  onClick={() => setSelectedToken(t.tokenAddress)}
                  style={{
                    background: "transparent",
                    border: "none",
                    padding: 0,
                    cursor: "pointer",
                    textAlign: "left",
                    fontFamily: "monospace",
                  }}
                >
                  {t.symbol}{" "}
                  <span style={{ opacity: 0.6, fontFamily: "monospace" }}>
                    {t.tokenAddress.slice(0, 6)}…{t.tokenAddress.slice(-4)}
                  </span>
                </button>
              </td>
              <td style={{ padding: 8, textAlign: "right" }}>{formatDepthNumber(t.depthSimple)}</td>
              <td style={{ padding: 8, textAlign: "right" }}>{formatDepthNumber(t.depthBand)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <section style={{ marginTop: 24 }}>
        <h2 style={{ margin: 0, marginBottom: 8 }}>
          {selectedToken ? "Token series" : "Token series (select a token)"}
        </h2>

        {selectedToken ? (
          <div style={{ height: 320 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={series.map((p) => ({
                  ts: p.timestamp.slice(0, 19).replace("T", " "),
                  depthSimple: Number(p.depthSimple),
                  depthBand: Number(p.depthBand),
                }))}
              >
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="ts" minTickGap={20} />
                <YAxis tickFormatter={(v) => formatDepthNumber(v)} />
                <Tooltip
                  formatter={(v: number | string, name: string) => [formatDepthNumber(v), name]}
                  labelFormatter={(label) => label}
                />
                <Line type="monotone" dataKey="depthSimple" stroke="#8884d8" dot={false} name="DepthSimple" />
                <Line type="monotone" dataKey="depthBand" stroke="#82ca9d" dot={false} name="DepthBand" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : null}
      </section>
    </main>
  );
}

