-- TimescaleDB (optional) schema for Monad Liquidity Depth dashboard (MVP)
-- Designed to run on both TimescaleDB and plain Postgres.

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS timescaledb;
EXCEPTION
  WHEN OTHERS THEN
    -- Allow the schema to load on Postgres instances without Timescale.
    -- Any create_hypertable calls below will be skipped if unavailable.
    NULL;
END $$;

CREATE TABLE IF NOT EXISTS dexes (
  name TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS tokens (
  token_address TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  name TEXT,
  decimals INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pools (
  pool_address TEXT PRIMARY KEY,
  dex TEXT NOT NULL REFERENCES dexes(name) ON DELETE CASCADE,
  token_addresses TEXT[] NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Timestamped pool snapshots (spot + raw liquidity/reserve/balance state).
CREATE TABLE IF NOT EXISTS pool_snapshots (
  ts TIMESTAMPTZ NOT NULL,
  dex TEXT NOT NULL REFERENCES dexes(name) ON DELETE CASCADE,
  pool_address TEXT NOT NULL REFERENCES pools(pool_address) ON DELETE CASCADE,
  spot_price_usd NUMERIC,
  token_amounts JSONB NOT NULL,
  token_prices_usd JSONB,
  PRIMARY KEY (ts, pool_address)
);

-- Token depth snapshots for a given band width.
CREATE TABLE IF NOT EXISTS token_depth_snapshots (
  ts TIMESTAMPTZ NOT NULL,
  dex TEXT NOT NULL REFERENCES dexes(name) ON DELETE CASCADE,
  token_address TEXT NOT NULL REFERENCES tokens(token_address) ON DELETE CASCADE,
  band_bps INT NOT NULL,
  depth_simple NUMERIC NOT NULL,
  depth_band NUMERIC NOT NULL,
  token_price_usd NUMERIC,
  PRIMARY KEY (ts, dex, token_address, band_bps)
);

-- Directional pool swap depth snapshots: max output token for selling token_in
-- into token_out while staying within a given price-space band around the pool's
-- current price.
CREATE TABLE IF NOT EXISTS pool_swap_depth_snapshots (
  ts TIMESTAMPTZ NOT NULL,
  dex TEXT NOT NULL REFERENCES dexes(name) ON DELETE CASCADE,
  pool_address TEXT NOT NULL REFERENCES pools(pool_address) ON DELETE CASCADE,
  band_bps INT NOT NULL,
  token_in TEXT NOT NULL REFERENCES tokens(token_address) ON DELETE CASCADE,
  token_out TEXT NOT NULL REFERENCES tokens(token_address) ON DELETE CASCADE,
  depth_simple NUMERIC NOT NULL,
  depth_band NUMERIC NOT NULL,
  token_price_usd NUMERIC,
  PRIMARY KEY (ts, dex, pool_address, band_bps, token_in, token_out)
);

-- Fast ranking table for the dashboard (top N tokens per snapshot).
CREATE TABLE IF NOT EXISTS token_top_n (
  ts TIMESTAMPTZ NOT NULL,
  dex TEXT NOT NULL REFERENCES dexes(name) ON DELETE CASCADE,
  band_bps INT NOT NULL,
  token_address TEXT NOT NULL REFERENCES tokens(token_address) ON DELETE CASCADE,
  rank INT NOT NULL,
  depth_simple NUMERIC NOT NULL,
  depth_band NUMERIC NOT NULL,
  PRIMARY KEY (ts, dex, band_bps, token_address)
);

CREATE INDEX IF NOT EXISTS idx_pool_snapshots_dex_ts ON pool_snapshots (dex, ts DESC);
CREATE INDEX IF NOT EXISTS idx_token_depth_snapshots_dex_token_ts ON token_depth_snapshots (dex, token_address, ts DESC);
CREATE INDEX IF NOT EXISTS idx_pool_swap_depth_snapshots_dex_inout_ts
  ON pool_swap_depth_snapshots (dex, token_in, token_out, ts DESC);
CREATE INDEX IF NOT EXISTS idx_token_top_n_dex_ts ON token_top_n (dex, ts DESC);

-- Lending snapshots: "borrowed against collateral" totals.
-- This dashboard currently focuses on MON/WMON collateral usage across lend markets.
CREATE TABLE IF NOT EXISTS lend_market_collateral_snapshots (
  ts TIMESTAMPTZ NOT NULL,
  protocol TEXT NOT NULL,
  market_id TEXT NOT NULL,
  collateral_token TEXT NOT NULL,
  loan_token TEXT NOT NULL,
  borrowed_amount NUMERIC NOT NULL,
  borrowed_amount_usd NUMERIC,
  PRIMARY KEY (ts, protocol, market_id, collateral_token, loan_token)
);

CREATE INDEX IF NOT EXISTS idx_lend_market_collateral_snapshots_protocol_ts
  ON lend_market_collateral_snapshots (protocol, ts DESC);
CREATE INDEX IF NOT EXISTS idx_lend_market_collateral_snapshots_collateral_ts
  ON lend_market_collateral_snapshots (collateral_token, ts DESC);

-- Morpho Blue: aggregated borrower health / liquidation proximity (indexer snapshot).
CREATE TABLE IF NOT EXISTS morpho_market_position_rollups (
  ts TIMESTAMPTZ NOT NULL,
  chain_id INT NOT NULL,
  position_count INT NOT NULL,
  histogram JSONB NOT NULL,
  top_positions JSONB NOT NULL,
  PRIMARY KEY (ts, chain_id)
);

CREATE INDEX IF NOT EXISTS idx_morpho_position_rollups_chain_ts
  ON morpho_market_position_rollups (chain_id, ts DESC);

-- Daily headline rollups for dashboard history (UTC date).
CREATE TABLE IF NOT EXISTS dashboard_daily_rollups (
  day DATE NOT NULL,
  borrow_usd_total NUMERIC,
  liquidity_usd_band_25 NUMERIC,
  liquidity_usd_band_100 NUMERIC,
  liquidity_usd_band_500 NUMERIC,
  ratio_band_100 NUMERIC,
  morpho_histogram JSONB,
  PRIMARY KEY (day)
);

-- Convert to hypertables (idempotent) when TimescaleDB is available.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'create_hypertable') THEN
    PERFORM create_hypertable('pool_snapshots', 'ts', if_not_exists => TRUE);
    PERFORM create_hypertable('token_depth_snapshots', 'ts', if_not_exists => TRUE);
    PERFORM create_hypertable('pool_swap_depth_snapshots', 'ts', if_not_exists => TRUE);
    PERFORM create_hypertable('token_top_n', 'ts', if_not_exists => TRUE);
    PERFORM create_hypertable('lend_market_collateral_snapshots', 'ts', if_not_exists => TRUE);
    PERFORM create_hypertable('morpho_market_position_rollups', 'ts', if_not_exists => TRUE);
  END IF;
END $$;

-- Pre-seed DEX names so adapters can insert without extra migrations.
INSERT INTO dexes(name)
VALUES ('uniswap_v3'), ('uniswap_v4'), ('curve'), ('balancer'), ('lfj'), ('pancake')
ON CONFLICT (name) DO NOTHING;

