# Deploy Monad Monitor (MVP)

This repo is set up as a monorepo with:
- `apps/web` (Next.js dashboard)
- `apps/api` (REST API for dashboard queries)
- `apps/indexer` (indexer worker that snapshots DEX liquidity depth into Postgres/Timescale)

## 1) Provision the database

Create a managed Postgres instance that supports the `timescaledb` extension (or run TimescaleDB yourself).

Set `DATABASE_URL` for:
- `apps/api`
- `apps/indexer`

## 2) Set required environment variables

At minimum:
- `MONAD_RPC_URL` (must allow `eth_getLogs` for recent backfill)
- `DATABASE_URL`

Optional but recommended for automated snapshots:
- `SNAPSHOT_CRON_SCHEDULE` (cron expression)
- `SNAPSHOT_TIMEZONE` (defaults to `UTC`)

Example:
- `SNAPSHOT_CRON_SCHEDULE=0 * * * *` (hourly)

## 3) Deploy `apps/web`

`apps/web` will call the API at relative paths (`/api/...`), so you have two options:
- Deploy `apps/api` and `apps/web` to the same host (reverse proxy), or
- Update the web app to point to the API host (not included in this MVP scaffolding).

In most PaaS setups, you can deploy `apps/web` as a web service and keep `apps/api` alongside it.

## 4) Deploy `apps/api`

Run:
- build: `npm -w apps/api run build`
- start: `npm -w apps/api run start`

API health check: `GET /healthz`

## 5) Deploy `apps/indexer` (scheduler + worker)

Run:
- build: `npm -w apps/indexer run build`
- start: `npm -w apps/indexer run start`

If `SNAPSHOT_CRON_SCHEDULE` is set, the indexer stays running and snapshots on that schedule.

## 6) Dashboard URL

After the web service is reachable, open the Next.js route you deployed (typically `/`).

