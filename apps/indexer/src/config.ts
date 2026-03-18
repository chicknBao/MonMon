import { z } from "zod";

export const envSchema = z.object({
  NODE_ENV: z.string().optional(),
  DATABASE_URL: z.string().min(1),
  MONAD_RPC_URL: z.string().min(1),
  MONAD_CHAIN_ID: z.coerce.number().int().positive().default(143),
  SNAPSHOT_BATCH_SIZE: z.coerce.number().int().positive().default(50),
  SNAPSHOT_TOP_N: z.coerce.number().int().positive().default(50),
  // Recent discovery (no archive RPC in MVP)
  DISCOVERY_LOOKBACK_BLOCKS: z.coerce.number().int().positive().default(200_000),
  DISCOVERY_MAX_POOLS: z.coerce.number().int().positive().default(500),

  // Depth band widths to persist (dashboards can query a specific band).
  BAND_BPS_LIST: z.string().default("50,100,200"),
  DEPTH_SIMPLE_BAND_BPS: z.coerce.number().int().positive().default(100),

  // Snapshot scheduling (optional). If unset, indexer runs once and exits.
  SNAPSHOT_CRON_SCHEDULE: z.string().optional(),
  SNAPSHOT_TIMEZONE: z.string().optional().default("UTC"),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(): Env {
  const raw = process.env;
  return envSchema.parse(raw);
}

