# Vercel deployment (fix 404 after “successful” build)

If the Vercel build logs look OK but the site returns **404 NOT_FOUND**, you almost always have one of these misconfigurations:

## 1) Wrong project type / output directory (most common)

If **Output Directory** is set to `public`, Vercel will deploy **only static files from `public/`**.
This repo’s `public/` folder is basically empty → **every route 404s**, even though “build succeeded”.

**Fix (Vercel → Project → Settings → Build & Output):**

- **Framework Preset**: **Next.js**
- **Root Directory**: **`apps/web`**
- **Build Command**: leave default, or use `npm run build` (see `apps/web/vercel.json`)
- **Install Command**: should run from monorepo root: `cd ../.. && npm ci` (already set in `apps/web/vercel.json`)
- **Output Directory**: **clear it** (must be empty for Next.js on Vercel)

Then redeploy.

## 2) Environment variables

Set in Vercel (Production + Preview):

- `DATABASE_URL` — required for `/api/top-tokens` and `/api/token-series`

Without it, API routes error at runtime (not usually a 404 on `/`, but you’ll see failures in the UI).

## 3) GitHub indexer (data)

The dashboard needs rows in Postgres. Run the GitHub Action workflow `indexer-snapshot` (or wait for the hourly cron) after setting repo secrets:

- `DATABASE_URL`
- `MONAD_RPC_URL`
