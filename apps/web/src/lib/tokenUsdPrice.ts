import type { Pool } from "pg";

const WMON = "0x3bd359c1119da7da1d913d1c4d2b7c461115433a";
const MON_NATIVE = "0x0000000000000000000000000000000000000000";

const STABLE_USD_1 = new Set<string>([
  "0x754704bc059f8c67012fed69bc8a327a5aafb603", // USDC
  "0xe7cd86e13ac4309349f30b3435a9d337750fc82d", // USDT
  "0x00000000efe302beaa2b3e6e1b18d08d69a9012a", // AUSD
]);

export function normalizeAddress(a: string): string {
  return a.toLowerCase();
}

/** Latest USD price string from pool_snapshots JSON map, or heuristics for MON/WMON/stables. */
export async function getLatestTokenUsdPrice(db: Pool, tokenAddress: string): Promise<string | null> {
  const addr = normalizeAddress(tokenAddress);
  if (addr === normalizeAddress(WMON) || addr === MON_NATIVE) return "1";
  if (STABLE_USD_1.has(addr)) return "1";

  const res = await db.query(
    `
      SELECT token_prices_usd->>$1 AS price
      FROM pool_snapshots
      WHERE token_prices_usd ? $1
      ORDER BY ts DESC
      LIMIT 1
    `,
    [addr],
  );
  const price = res.rows[0]?.price as string | null | undefined;
  return price ?? null;
}

export function depthBandTimesUsd(depthBand: string, priceUsd: string | null): number {
  const d = Number(depthBand);
  const p = priceUsd == null || priceUsd === "" ? NaN : Number(priceUsd);
  if (!Number.isFinite(d) || !Number.isFinite(p)) return 0;
  return d * p;
}
