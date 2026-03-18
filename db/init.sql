-- TimescaleDB schema for Monad Liquidity Depth dashboard (MVP)

CREATE EXTENSION IF NOT EXISTS timescaledb;

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
CREATE INDEX IF NOT EXISTS idx_token_top_n_dex_ts ON token_top_n (dex, ts DESC);

-- Convert to hypertables (idempotent).
SELECT create_hypertable('pool_snapshots', 'ts', if_not_exists => TRUE);
SELECT create_hypertable('token_depth_snapshots', 'ts', if_not_exists => TRUE);
SELECT create_hypertable('token_top_n', 'ts', if_not_exists => TRUE);

-- Pre-seed DEX names so adapters can insert without extra migrations.
INSERT INTO dexes(name)
VALUES ('uniswap_v3'), ('curve'), ('balancer'), ('lfj')
ON CONFLICT (name) DO NOTHING;

