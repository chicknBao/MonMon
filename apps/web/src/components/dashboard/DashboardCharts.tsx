"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { BandChartRow, HistoryChartPoint, NamedUsdRow } from "../../app/dashboard/dashboardChartData";
import { formatDepthNumber } from "../../app/dashboard/dashboardFormat";

const GRID_STROKE = "var(--color-border-subtle)";
const tickStyle = { fontSize: 11, fill: "var(--color-text-muted)" };

function historyTooltipFormatter(value: number, name: string): [string, string] {
  if (name === "Ratio") {
    return [Number.isFinite(value) ? formatDepthNumber(value) : "—", name];
  }
  return [`$${formatDepthNumber(value)}`, name];
}

export function HistoryBorrowLiquidityChart({ data }: { data: HistoryChartPoint[] }) {
  if (data.length === 0) return null;
  return (
    <figure
      style={{ margin: 0, width: "100%" }}
      aria-label="Line chart: borrow and liquidity in USD by UTC day, with borrow-to-liquidity ratio on a separate vertical scale."
    >
      <ResponsiveContainer width="100%" height={260}>
        <ComposedChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 28 }}>
          <CartesianGrid stroke={GRID_STROKE} />
          <XAxis
            dataKey="day"
            tick={tickStyle}
            interval="preserveStartEnd"
            angle={-32}
            textAnchor="end"
            height={54}
          />
          <YAxis
            yAxisId="usd"
            tick={tickStyle}
            tickFormatter={(v) => `$${formatDepthNumber(v)}`}
            width={76}
          />
          <YAxis
            yAxisId="ratio"
            orientation="right"
            tick={tickStyle}
            tickFormatter={(v) => formatDepthNumber(v)}
            width={44}
          />
          <Tooltip
            formatter={(value, name) => {
              const raw = Array.isArray(value) ? value[0] : value;
              const n = raw === "" || raw == null ? NaN : Number(raw);
              return historyTooltipFormatter(n, String(name));
            }}
            labelFormatter={(label) => `Day: ${label}`}
            contentStyle={{ fontSize: 12 }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Line
            yAxisId="usd"
            type="monotone"
            dataKey="borrow"
            name="Borrow USD"
            stroke="#2563eb"
            dot={false}
            strokeWidth={2}
          />
          <Line
            yAxisId="usd"
            type="monotone"
            dataKey="liquidity"
            name="Liq. ±100 bps USD"
            stroke="#16a34a"
            dot={false}
            strokeWidth={2}
          />
          <Line
            yAxisId="ratio"
            type="monotone"
            dataKey="ratio"
            name="Ratio"
            stroke="#ca8a04"
            dot={false}
            strokeWidth={2}
            connectNulls={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </figure>
  );
}

export function MorphoHistogramChart({ data }: { data: Array<{ label: string; count: number }> }) {
  if (data.length === 0) return null;
  return (
    <figure
      style={{ margin: 0, width: "100%" }}
      aria-label="Bar chart: Morpho position counts by health factor band."
    >
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 56 }}>
          <CartesianGrid stroke={GRID_STROKE} />
          <XAxis dataKey="label" tick={tickStyle} interval={0} angle={-28} textAnchor="end" height={70} />
          <YAxis tick={tickStyle} allowDecimals={false} width={36} />
          <Tooltip
            formatter={(value) => {
              const raw = Array.isArray(value) ? value[0] : value;
              const n = typeof raw === "number" ? raw : Number(raw);
              return [Number.isFinite(n) ? n : raw, "Positions"];
            }}
            labelFormatter={(l) => String(l)}
            contentStyle={{ fontSize: 12 }}
          />
          <Bar dataKey="count" name="Count" fill="#7c3aed" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </figure>
  );
}

export function BorrowByProtocolChart({ rows }: { rows: NamedUsdRow[] }) {
  if (rows.length === 0) return null;
  const chartData = [...rows].reverse();
  return (
    <figure
      style={{ margin: 0, width: "100%" }}
      aria-label="Horizontal bar chart: borrow USD by lending protocol."
    >
      <ResponsiveContainer width="100%" height={Math.max(160, chartData.length * 36 + 48)}>
        <BarChart layout="vertical" data={chartData} margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
          <CartesianGrid stroke={GRID_STROKE} />
          <XAxis type="number" tick={tickStyle} tickFormatter={(v) => `$${formatDepthNumber(v)}`} />
          <YAxis type="category" dataKey="name" width={100} tick={tickStyle} />
          <Tooltip
            formatter={(value) => {
              const raw = Array.isArray(value) ? value[0] : value;
              const n = typeof raw === "number" ? raw : Number(raw);
              return [`$${formatDepthNumber(Number.isFinite(n) ? n : 0)}`, "Borrow USD"];
            }}
            contentStyle={{ fontSize: 12 }}
          />
          <Bar dataKey="usd" fill="#4f46e5" radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </figure>
  );
}

function bandTooltipFormatter(value: number, name: string): [string, string] {
  if (name === "Ratio") {
    return [Number.isFinite(value) ? formatDepthNumber(value) : "—", name];
  }
  return [`$${formatDepthNumber(value)}`, name];
}

export function BandsLiquidityChart({ rows }: { rows: BandChartRow[] }) {
  if (rows.length === 0) return null;
  return (
    <figure
      style={{ margin: 0, width: "100%" }}
      aria-label="Bar chart: liquidity USD by price band, with borrow-to-liquidity ratio as a line on a second scale."
    >
      <ResponsiveContainer width="100%" height={240}>
        <ComposedChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
          <CartesianGrid stroke={GRID_STROKE} />
          <XAxis dataKey="bandLabel" tick={tickStyle} />
          <YAxis
            yAxisId="usd"
            tick={tickStyle}
            tickFormatter={(v) => `$${formatDepthNumber(v)}`}
            width={76}
          />
          <YAxis
            yAxisId="ratio"
            orientation="right"
            tick={tickStyle}
            tickFormatter={(v) => formatDepthNumber(v)}
            width={44}
          />
          <Tooltip
            formatter={(value, name) => {
              const raw = Array.isArray(value) ? value[0] : value;
              const n = raw === "" || raw == null ? NaN : Number(raw);
              return bandTooltipFormatter(n, String(name));
            }}
            contentStyle={{ fontSize: 12 }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar yAxisId="usd" dataKey="liquidity" name="Liquidity USD" fill="#0284c7" radius={[4, 4, 0, 0]} />
          <Line
            yAxisId="ratio"
            type="monotone"
            dataKey="ratio"
            name="Ratio"
            stroke="#b45309"
            strokeWidth={2}
            dot={{ r: 4 }}
            connectNulls={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </figure>
  );
}

export function DexLiquidityChart({ rows }: { rows: NamedUsdRow[] }) {
  if (rows.length === 0) return null;
  const chartData = [...rows].reverse();
  return (
    <figure
      style={{ margin: 0, width: "100%" }}
      aria-label="Horizontal bar chart: estimated MON-side liquidity USD by DEX at plus or minus 100 basis points."
    >
      <ResponsiveContainer width="100%" height={Math.max(160, chartData.length * 36 + 48)}>
        <BarChart layout="vertical" data={chartData} margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
          <CartesianGrid stroke={GRID_STROKE} />
          <XAxis type="number" tick={tickStyle} tickFormatter={(v) => `$${formatDepthNumber(v)}`} />
          <YAxis type="category" dataKey="name" width={120} tick={tickStyle} />
          <Tooltip
            formatter={(value) => {
              const raw = Array.isArray(value) ? value[0] : value;
              const n = typeof raw === "number" ? raw : Number(raw);
              return [`$${formatDepthNumber(Number.isFinite(n) ? n : 0)}`, "Liquidity USD"];
            }}
            contentStyle={{ fontSize: 12 }}
          />
          <Bar dataKey="usd" fill="#0d9488" radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </figure>
  );
}
