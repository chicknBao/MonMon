import type { Express } from "express";
import type { Pool } from "pg";

const DEXES = ["uniswap_v3", "curve", "balancer", "lfj"] as const;
type DexName = (typeof DEXES)[number] | "all";

function parseDex(input: unknown): DexName {
  const s = String(input ?? "uniswap_v3");
  if (s === "all") return "all";
  if ((DEXES as readonly string[]).includes(s)) return s as DexName;
  return "uniswap_v3";
}

function parseBandBps(input: unknown): number {
  const n = Number(input ?? 100);
  if (!Number.isFinite(n) || n <= 0 || n >= 20000) return 100;
  return n;
}

function parseLimit(input: unknown): number {
  const n = Number(input ?? 50);
  if (!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(200, Math.max(1, Math.floor(n)));
}

export function registerRoutes(app: Express, db: Pool) {
  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  app.get("/api/top-tokens", async (req, res) => {
    try {
      const dex = parseDex(req.query.dex);
      const bandBps = parseBandBps(req.query.bandBps);
      const limit = parseLimit(req.query.limit);

      const dexList = dex === "all" ? DEXES : [dex];

      const latestTsRes = await db.query(
        `SELECT max(ts) AS ts
         FROM token_depth_snapshots
         WHERE band_bps = $1 AND dex = ANY($2::text[])`,
        [bandBps, dexList],
      );
      const latestTs = latestTsRes.rows[0]?.ts as string | null;

      if (!latestTs) {
        res.json({ bandBps, dex, latestTs: null, tokens: [] });
        return;
      }

      const tokensRes = await db.query(
        `SELECT
           t.dex,
           t.token_address,
           COALESCE(tok.symbol, t.token_address) AS symbol,
           COALESCE(tok.decimals, 0) AS decimals,
           t.depth_simple,
           t.depth_band
         FROM token_depth_snapshots t
         LEFT JOIN tokens tok ON tok.token_address = t.token_address
         WHERE t.band_bps = $1
           AND t.dex = ANY($2::text[])
           AND t.ts = $3::timestamptz
         ORDER BY t.depth_simple DESC
         LIMIT $4`,
        [bandBps, dexList, latestTs, limit],
      );

      res.json({
        bandBps,
        dex,
        latestTs,
        tokens: tokensRes.rows.map((r) => ({
          dex: r.dex,
          tokenAddress: r.token_address,
          symbol: r.symbol,
          decimals: Number(r.decimals),
          depthSimple: r.depth_simple?.toString() ?? "0",
          depthBand: r.depth_band?.toString() ?? "0",
        })),
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "top-tokens failed" });
    }
  });

  app.get("/api/token-series", async (req, res) => {
    try {
      const dex = parseDex(req.query.dex);
      const tokenAddress = String(req.query.tokenAddress ?? req.query.token ?? "");
      const bandBps = parseBandBps(req.query.bandBps);
      const limit = parseLimit(req.query.limit ?? 200);

      if (!tokenAddress) {
        res.status(400).json({ error: "tokenAddress is required" });
        return;
      }

      const dexList = dex === "all" ? DEXES : [dex];

      const seriesRes = await db.query(
        `SELECT
           t.dex,
           t.ts,
           t.depth_simple,
           t.depth_band,
           tok.symbol
         FROM token_depth_snapshots t
         LEFT JOIN tokens tok ON tok.token_address = t.token_address
         WHERE t.band_bps = $1
           AND t.dex = ANY($2::text[])
           AND t.token_address = $3
         ORDER BY t.ts ASC
         LIMIT $4`,
        [bandBps, dexList, tokenAddress.toLowerCase(), limit],
      );

      res.json({
        dex,
        tokenAddress: tokenAddress.toLowerCase(),
        bandBps,
        series: seriesRes.rows.map((r) => ({
          dex: r.dex,
          timestamp: r.ts.toISOString(),
          depthSimple: r.depth_simple?.toString() ?? "0",
          depthBand: r.depth_band?.toString() ?? "0",
          symbol: r.symbol ?? tokenAddress,
        })),
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "token-series failed" });
    }
  });
}

