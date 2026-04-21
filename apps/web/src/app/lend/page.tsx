"use client";

import { useEffect, useState } from "react";

type LendMarketSlot = {
  usd: string | null;
  amount: string;
  loanTokenSymbol: string | null;
};

type LendMarketRow = {
  protocol: string;
  marketId: string;
  mon: LendMarketSlot;
  wmon: LendMarketSlot;
};

type LendApiResponse = {
  latestTs: string | null;
  markets: LendMarketRow[];
  all: { monUsd: string | null; wmonUsd: string | null };
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

export default function LendPage() {
  const [data, setData] = useState<LendApiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/lend-markets");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as LendApiResponse;
        if (!cancelled) setData(json);
      } catch (e: any) {
        if (!cancelled) setError(String(e?.message ?? e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    run();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="pageMain" style={{ color: "var(--color-text-muted)" }}>
        Loading lending markets…
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

  const markets = data?.markets ?? [];
  const all = data?.all;

  return (
    <main className="pageMain">
      <h1 style={{ margin: "0 0 var(--space-2) 0" }}>Lending</h1>
      <div className="pageMuted" style={{ marginBottom: "var(--space-4)" }}>
        Snapshot: {data?.latestTs ?? "—"}
      </div>

      <div style={{ display: "flex", gap: "var(--space-4)", marginBottom: "var(--space-4)", flexWrap: "wrap" }}>
        <div className="pageCard" style={{ flex: "1 1 200px", padding: "var(--space-3)" }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>MON</div>
          <div style={{ fontSize: 22, fontWeight: 800, fontFamily: "var(--font-mono)" }}>
            {all?.monUsd ? `$${formatDepthNumber(all.monUsd)}` : "—"}
          </div>
          <div className="pageMuted" style={{ fontSize: 12, marginTop: 4 }}>
            Total borrowed value backed by MON collateral
          </div>
        </div>
        <div className="pageCard" style={{ flex: "1 1 200px", padding: "var(--space-3)" }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>WMON</div>
          <div style={{ fontSize: 22, fontWeight: 800, fontFamily: "var(--font-mono)" }}>
            {all?.wmonUsd ? `$${formatDepthNumber(all.wmonUsd)}` : "—"}
          </div>
          <div className="pageMuted" style={{ fontSize: 12, marginTop: 4 }}>
            Total borrowed value backed by WMON collateral
          </div>
        </div>
      </div>

      <div className="pageTableShell">
        <div
          className="pageTableHead"
          style={{
            display: "grid",
            gridTemplateColumns: "1.2fr 0.9fr 0.9fr",
          }}
        >
          <div>Market</div>
          <div>MON collateral</div>
          <div>WMON collateral</div>
        </div>

        {markets.length === 0 ? (
          <div className="dashboardEmpty">No lending markets found for snapshot.</div>
        ) : (
          markets.map((m) => (
            <div
              key={`${m.protocol}:${m.marketId}`}
              className="pageTableRow"
              style={{
                display: "grid",
                gridTemplateColumns: "1.2fr 0.9fr 0.9fr",
              }}
            >
              <div>
                <div style={{ fontWeight: 800 }}>{m.protocol}</div>
                <div className="pageMuted" style={{ fontSize: 12 }}>
                  {m.marketId}
                </div>
              </div>

              {renderCollateralSlot(m.mon)}
              {renderCollateralSlot(m.wmon)}
            </div>
          ))
        )}
      </div>
    </main>
  );
}

function renderCollateralSlot(slot: LendMarketSlot) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ fontWeight: 800 }}>
        {slot.usd ? `$${formatDepthNumber(slot.usd)}` : "—"}
      </div>
      <div className="pageMuted" style={{ fontSize: 12 }}>
        {slot.amount !== "0" ? (
          <>
            {formatDepthNumber(slot.amount)} {slot.loanTokenSymbol ? slot.loanTokenSymbol : ""}
          </>
        ) : (
          "—"
        )}
      </div>
    </div>
  );
}

