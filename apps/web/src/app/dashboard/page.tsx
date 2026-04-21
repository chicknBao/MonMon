"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

const MON = "0x0000000000000000000000000000000000000000";
const DEXES = ["uniswap_v3", "uniswap_v4", "curve", "balancer", "lfj", "pancake"] as const;

type LendApiResponse = {
  latestTs: string | null;
  all: { monUsd: string | null; wmonUsd: string | null };
};

type SwapTotalsResponse = {
  latestTs: string | null;
  totals: Array<{ depthBand: string }>;
};

type DexLiquidityRow = {
  dex: string;
  liquidity: string;
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

function sumDepthBand(totals: Array<{ depthBand: string }>): string {
  let sum = 0;
  for (const row of totals) {
    const n = Number(row.depthBand ?? "0");
    if (Number.isFinite(n)) sum += n;
  }
  return String(sum);
}

export default function DashboardPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [borrowedUsd, setBorrowedUsd] = useState<string>("0");
  const [liquidityUsd, setLiquidityUsd] = useState<string>("0");
  const [dexRows, setDexRows] = useState<DexLiquidityRow[]>([]);
  const [latestTs, setLatestTs] = useState<string | null>(null);

  const swapQueryBase = useMemo(() => {
    const params = new URLSearchParams({
      tokenIn: MON,
      bandBps: "100",
      limitTokens: "100",
      limitPools: "200",
    });
    return params;
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      setLoading(true);
      setError(null);
      try {
        const lendReq = fetch("/api/lend-markets").then(async (r) => {
          if (!r.ok) throw new Error(`lend HTTP ${r.status}`);
          return (await r.json()) as LendApiResponse;
        });

        const allParams = new URLSearchParams(swapQueryBase);
        allParams.set("dex", "all");
        const allSwapReq = fetch(`/api/top-swap-outputs?${allParams.toString()}`).then(async (r) => {
          if (!r.ok) throw new Error(`swap(all) HTTP ${r.status}`);
          return (await r.json()) as SwapTotalsResponse;
        });

        const dexReqs = DEXES.map(async (dex) => {
          const params = new URLSearchParams(swapQueryBase);
          params.set("dex", dex);
          const r = await fetch(`/api/top-swap-outputs?${params.toString()}`);
          if (!r.ok) throw new Error(`swap(${dex}) HTTP ${r.status}`);
          const json = (await r.json()) as SwapTotalsResponse;
          return { dex, liquidity: sumDepthBand(json.totals ?? []) };
        });

        const [lend, allSwap, ...perDex] = await Promise.all([lendReq, allSwapReq, ...dexReqs]);
        if (cancelled) return;

        const monUsd = Number(lend.all?.monUsd ?? "0");
        const wmonUsd = Number(lend.all?.wmonUsd ?? "0");
        setBorrowedUsd(String((Number.isFinite(monUsd) ? monUsd : 0) + (Number.isFinite(wmonUsd) ? wmonUsd : 0)));
        setLiquidityUsd(sumDepthBand(allSwap.totals ?? []));
        setDexRows(
          perDex
            .map((d) => ({ dex: d.dex, liquidity: d.liquidity }))
            .sort((a, b) => Number(b.liquidity) - Number(a.liquidity)),
        );
        setLatestTs(allSwap.latestTs ?? lend.latestTs ?? null);
      } catch (e: unknown) {
        if (!cancelled) {
          const message = e instanceof Error ? e.message : "Failed to load dashboard";
          setError(message);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [swapQueryBase]);

  if (loading) return <div style={{ padding: 24 }}>Loading dashboard…</div>;
  if (error) return <div style={{ padding: 24 }}>Error: {error}</div>;

  return (
    <main style={{ padding: 24 }}>
      <h1 style={{ margin: 0 }}>Dashboard</h1>
      <div style={{ opacity: 0.7, marginTop: 8, marginBottom: 16, fontFamily: "monospace" }}>
        latestTs: {latestTs ?? "null"}
      </div>

      <section style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
        <article style={{ border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
          <div style={{ fontSize: 12, opacity: 0.7 }}>Borrowed Against MON</div>
          <div style={{ fontSize: 28, fontWeight: 800, marginTop: 6 }}>${formatDepthNumber(borrowedUsd)}</div>
          <div style={{ marginTop: 10 }}>
            <Link href="/lend" style={{ textDecoration: "none" }}>
              More info
            </Link>
          </div>
        </article>

        <article style={{ border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
          <div style={{ fontSize: 12, opacity: 0.7 }}>Liquidity For MON</div>
          <div style={{ fontSize: 28, fontWeight: 800, marginTop: 6 }}>${formatDepthNumber(liquidityUsd)}</div>
          <div style={{ marginTop: 10 }}>
            <Link href="/swap" style={{ textDecoration: "none" }}>
              More info
            </Link>
          </div>
        </article>
      </section>

      <section style={{ marginTop: 22 }}>
        <h2 style={{ margin: 0, marginBottom: 10, fontSize: 18 }}>Liquidity by Platform</h2>
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
            <div>Platform</div>
            <div>Liquidity</div>
          </div>
          {dexRows.map((row) => (
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
              <div style={{ fontFamily: "monospace" }}>${formatDepthNumber(row.liquidity)}</div>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
