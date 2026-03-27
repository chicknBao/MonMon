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
  BAND_BPS_LIST: z.string().default("25,50,100,200,500"),
  DEPTH_SIMPLE_BAND_BPS: z.coerce.number().int().positive().default(100),

  // Uniswap v4 (PoC)
  // PoolIds are the bytes32 Uniswap v4 poolIds (not addresses).
  UNISWAP_V4_POOL_MANAGER: z.string().optional(),
  UNISWAP_V4_POSITION_MANAGER: z.string().optional(),
  UNISWAP_V4_STATE_VIEW: z.string().optional(),
  UNISWAP_V4_POOL_IDS: z.string().optional(),

  // Curve: MetaRegistry-style contract (pool_count / pool_list / get_*). On Monad (143),
  // defaults in the indexer to the official MetaRegistry if this is unset. Set to "" to opt out.
  CURVE_REGISTRY: z.string().optional(),
  CURVE_POOL_ADDRESSES: z.string().optional(),

  // Balancer V3 on Monad: optional overrides (defaults match Balancer docs for chain 143).
  BALANCER_V3_VAULT: z.string().optional(),
  BALANCER_V3_ROUTER: z.string().optional(),
  BALANCER_V3_FACTORY_ADDRESSES: z.string().optional(),

  // Snapshot scheduling (optional). If unset, indexer runs once and exits.
  SNAPSHOT_CRON_SCHEDULE: z.string().optional(),
  SNAPSHOT_TIMEZONE: z.string().optional().default("UTC"),

  // Lending: optional Neverland HyperIndex / Hasura GraphQL (see neverland-hyperindex schema).
  NEVERLAND_LENDING_GRAPHQL_URL: z.string().optional(),
  NEVERLAND_LENDING_GRAPHQL_SECRET: z.string().optional(),
  NEVERLAND_LENDING_GRAPHQL_PAGE_SIZE: z.coerce.number().int().positive().default(500),
  NEVERLAND_LENDING_GRAPHQL_MAX_USERS: z.coerce.number().int().positive().default(5000),

  // Lending: optional comma-separated Curvance MarketManager addresses (WMON collateral markets).
  CURVANCE_WMON_MARKET_MANAGERS: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(): Env {
  return envSchema.parse(process.env);
}

