/** Stable key order for Morpho HF histogram bars and table rows. */
export const MORPHO_HISTOGRAM_KEY_ORDER = [
  "lt_1",
  "gte_1_lt_1_05",
  "gte_1_05_lt_1_1",
  "gte_1_1_lt_1_2",
  "gte_1_2_lt_1_5",
  "gte_1_5_lt_2",
  "gte_2",
  "gte_1_5",
  "unknown",
] as const;

export const MORPHO_HISTOGRAM_LABELS: Record<string, string> = {
  lt_1: "HF below 1",
  gte_1_lt_1_05: "1.0 – 1.05",
  gte_1_05_lt_1_1: "1.05 – 1.1",
  gte_1_1_lt_1_2: "1.1 – 1.2",
  gte_1_2_lt_1_5: "1.2 – 1.5",
  gte_1_5_lt_2: "1.5 – 2.0",
  gte_2: "≥ 2",
  gte_1_5: "≥ 1.5 (legacy bucket)",
  unknown: "Unknown HF",
};

/** Per-band stats from indexer (new) or legacy count-only histogram from DB. */
export type MorphoBandStats = { count: number; borrowUsd: number };

/** Accepts new `{ count, borrowUsd }` values or legacy plain number counts. */
export function normalizeMorphoHistogram(raw: unknown): Record<string, MorphoBandStats> | null {
  if (raw == null || typeof raw !== "object") return null;
  const src = raw as Record<string, unknown>;
  const out: Record<string, MorphoBandStats> = {};
  for (const [k, v] of Object.entries(src)) {
    if (typeof v === "number" && Number.isFinite(v)) {
      out[k] = { count: v, borrowUsd: 0 };
    } else if (v != null && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const count = Number(o.count);
      const borrowUsd = Number(o.borrowUsd ?? 0);
      out[k] = {
        count: Number.isFinite(count) ? count : 0,
        borrowUsd: Number.isFinite(borrowUsd) ? borrowUsd : 0,
      };
    }
  }
  return Object.keys(out).length ? out : null;
}

export type HistoryChartPoint = {
  day: string;
  borrow: number;
  liquidity: number;
  ratio: number | null;
};

export function buildHistoryChartData(
  rows: Array<{
    day: string;
    borrow_usd_total: string | null;
    liquidity_usd_band_100: string | null;
    ratio_band_100: string | null;
  }>,
): HistoryChartPoint[] {
  return [...rows]
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((r) => ({
      day: r.day,
      borrow: Number(r.borrow_usd_total ?? 0),
      liquidity: Number(r.liquidity_usd_band_100 ?? 0),
      ratio:
        r.ratio_band_100 != null && r.ratio_band_100 !== ""
          ? Number(r.ratio_band_100)
          : null,
    }));
}

/** Keys present in histogram, in canonical order, then any extra keys. */
export function orderedMorphoHistogramEntries(
  histogram: Record<string, MorphoBandStats>,
): [string, MorphoBandStats][] {
  const out: [string, MorphoBandStats][] = [];
  const seen = new Set<string>();
  for (const k of MORPHO_HISTOGRAM_KEY_ORDER) {
    if (Object.prototype.hasOwnProperty.call(histogram, k)) {
      out.push([k, histogram[k]!]);
      seen.add(k);
    }
  }
  for (const k of Object.keys(histogram)) {
    if (!seen.has(k)) out.push([k, histogram[k]!]);
  }
  return out;
}

export type BandChartRow = {
  bandLabel: string;
  liquidity: number;
  ratio: number | null;
};

export function buildBandChartRows(
  bands: Array<{ bandBps: number; liquidityUsdTotal: string; safetyRatio: string | null }>,
): BandChartRow[] {
  return [...bands]
    .sort((a, b) => a.bandBps - b.bandBps)
    .map((b) => ({
      bandLabel: `${b.bandBps} bps`,
      liquidity: Number(b.liquidityUsdTotal),
      ratio: b.safetyRatio != null && b.safetyRatio !== "" ? Number(b.safetyRatio) : null,
    }));
}

export type NamedUsdRow = { name: string; usd: number };

export function buildDexChartRows(liquidityByDexUsd: Record<string, string>): NamedUsdRow[] {
  return Object.entries(liquidityByDexUsd)
    .map(([name, usd]) => ({ name, usd: Number(usd) }))
    .filter((r) => Number.isFinite(r.usd))
    .sort((a, b) => b.usd - a.usd);
}

export function buildProtocolChartRows(protocols: Array<{ protocol: string; usd: string }>): NamedUsdRow[] {
  return protocols
    .map((p) => ({ name: p.protocol, usd: Number(p.usd) }))
    .filter((r) => Number.isFinite(r.usd))
    .sort((a, b) => b.usd - a.usd);
}
