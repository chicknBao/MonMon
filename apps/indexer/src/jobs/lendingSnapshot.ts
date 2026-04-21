import type { Pool } from 'pg'
import type { Env } from '../config.js'
import { createMonadPublicClient } from '../monadPublicClient.js'
import { upsertLendMarketCollateralSnapshot } from '../repositories/lending.js'
import { formatUnits } from '@monmon/shared'

const WMON = '0x3bd359c1119da7da1d913d1c4d2b7c461115433a'
const MON_NATIVE = '0x0000000000000000000000000000000000000000'

const MORPHO_GRAPHQL = 'https://blue-api.morpho.org/graphql'

/**
 * Curvance MarketManager addresses where **WMON** is a listed collateral leg (cWMON `asset()` === WMON).
 * WMON/USDC matches docs; WMON/AUSD docs duplicate the wrong address — on-chain manager is from
 * SimplePositionManager `0x2619BB5Acfe51317c4C36a63578FD56148e68C74` → `marketManager()`.
 * LST rows: caprMON/cWMON, cshMON/cWMON, csMON/cWMON, cgMON/cWMON (Curvance “LST Markets” on Monad).
 */
const DEFAULT_CURVANCE_WMON_COLLATERAL_MARKET_MANAGERS = [
  '0xa6a2a92f126b79ee0804845ee6b52899b4491093', // WMON / USDC (DeFi Bluechip)
  '0x05e70717fa8bd0f21a9f826d093d99f6da4f1554', // WMON / AUSD (not 0xd636… — that is earnAUSD/csAUSD)
  '0x5ea0a1cf3501c954b64902c5e92100b8a2cab1ac', // caprMON / cWMON
  '0xe1c24b2e93230fbe33d32ba38eca3218284143e2', // cshMON / cWMON
  '0xe5970cdb1916b2ccf6185c86c174eee2d330d05b', // csMON / cWMON
  '0xb00aff53a4df2b4e2f97a3d9ffadb55564c8e42f', // cgMON / cWMON
]

function normalizeAddress(a: string): string {
  return a.toLowerCase()
}

const STABLE_TOKENS_USD_1 = new Set<string>([
  '0x754704bc059f8c67012fed69bc8a327a5aafb603', // USDC
  '0xe7cd86e13ac4309349f30b3435a9d337750fc82d', // USDT
  '0x00000000efe302beaa2b3e6e1b18d08d69a9012a', // AUSD
])

function parseDecimalStringToScaled1e18(input: string): bigint | null {
  const s = input.trim()
  if (!s) return null
  const neg = s.startsWith('-')
  const x = neg ? s.slice(1) : s
  const [whole, fracRaw = ''] = x.split('.')
  if (!/^\d+$/.test(whole)) return null
  const frac = fracRaw.replace(/_+/g, '')
  if (!/^\d*$/.test(frac)) return null

  const wholeScaled = BigInt(whole) * 10n ** 18n
  const fracPadded = frac.padEnd(18, '0').slice(0, 18)
  const fracScaled = fracPadded.length ? BigInt(fracPadded) : 0n
  const out = wholeScaled + fracScaled
  return neg ? -out : out
}

function formatScaledUsd18ToPostgres(valueScaled18: bigint): string {
  const neg = valueScaled18 < 0n
  const abs = neg ? -valueScaled18 : valueScaled18
  const SCALE_1E18 = 10n ** 18n
  const whole = abs / SCALE_1E18
  const frac = abs % SCALE_1E18
  if (frac === 0n) return `${neg ? '-' : ''}${whole.toString()}`
  const fracStr = frac.toString().padStart(18, '0').replace(/0+$/, '')
  return `${neg ? '-' : ''}${whole.toString()}.${fracStr}`
}

async function getLatestTokenUsdPrice(db: Pool, tokenAddress: string): Promise<string | null> {
  const addr = normalizeAddress(tokenAddress)
  if (addr === normalizeAddress(WMON) || addr === MON_NATIVE) return '1'
  if (STABLE_TOKENS_USD_1.has(addr)) return '1'

  const res = await db.query(
    `
      SELECT token_prices_usd->>$1 AS price
      FROM pool_snapshots
      WHERE token_prices_usd ? $1
      ORDER BY ts DESC
      LIMIT 1
    `,
    [addr],
  )
  const price = res.rows[0]?.price as string | null | undefined
  return price ?? null
}

async function borrowedUsdFromDbPrice(
  db: Pool,
  loanToken: string,
  rawBorrowed: bigint,
  loanDecimals: number,
) {
  const priceUsdStr = await getLatestTokenUsdPrice(db, loanToken)
  if (!priceUsdStr) return null
  const priceScaled = parseDecimalStringToScaled1e18(priceUsdStr)
  if (!priceScaled) return null
  const borrowedScaled = (rawBorrowed * 10n ** 18n) / 10n ** BigInt(loanDecimals)
  const borrowedUsdScaled = (borrowedScaled * priceScaled) / 10n ** 18n
  return formatScaledUsd18ToPostgres(borrowedUsdScaled)
}

async function fetchMorphoMarketsByCollateral(params: {
  chainId: number
  collateralAssets: string[]
  first: number
}) {
  const { chainId, collateralAssets, first } = params
  const query = `
    query Markets($chainId: Int!, $collateralAssets: [String!], $first: Int!) {
      markets(
        first: $first,
        orderBy: BorrowAssetsUsd,
        orderDirection: Desc,
        where: { chainId_in: [$chainId], collateralAssetAddress_in: $collateralAssets, listed: true }
      ) {
        items {
          uniqueKey
          loanAsset { address symbol decimals }
          collateralAsset { address symbol decimals }
          state { borrowAssets borrowAssetsUsd }
        }
      }
    }
  `

  const res = await fetch(MORPHO_GRAPHQL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query,
      variables: {
        chainId,
        collateralAssets,
        first,
      },
    }),
  })

  if (!res.ok) {
    throw new Error(`Morpho graphql HTTP ${res.status}`)
  }

  const json: any = await res.json()
  if (json.errors?.length) {
    throw new Error(`Morpho graphql errors: ${JSON.stringify(json.errors)}`)
  }

  return (json.data?.markets?.items ?? []) as Array<{
    uniqueKey: string
    loanAsset: { address: string; symbol?: string | null; decimals?: string | number | null }
    collateralAsset: { address: string; symbol?: string | null; decimals?: string | number | null }
    state: { borrowAssets: string; borrowAssetsUsd: string }
  }>
}

export async function runMorphoLendingSnapshot(params: {
  env: Env
  db: Pool
  snapshotTs: string
}): Promise<number> {
  const { env, db, snapshotTs } = params
  const markets = await fetchMorphoMarketsByCollateral({
    chainId: env.MONAD_CHAIN_ID,
    collateralAssets: [WMON, MON_NATIVE],
    first: Math.max(1, env.DISCOVERY_MAX_POOLS),
  })

  let upserted = 0
  for (const m of markets) {
    const marketId = String(m.uniqueKey)
    const loanToken = normalizeAddress(m.loanAsset.address)
    const collateralToken = normalizeAddress(m.collateralAsset.address)
    const borrowedAmount = m.state?.borrowAssets != null ? String(m.state.borrowAssets) : '0'
    const borrowedAmountUsd =
      m.state?.borrowAssetsUsd != null && String(m.state.borrowAssetsUsd).length > 0
        ? String(m.state.borrowAssetsUsd)
        : null

    if (
      collateralToken !== normalizeAddress(WMON) &&
      collateralToken !== normalizeAddress(MON_NATIVE)
    )
      continue
    if (!borrowedAmount || borrowedAmount === '0') continue

    await upsertLendMarketCollateralSnapshot(db, {
      timestamp: snapshotTs,
      protocol: 'morpho',
      marketId,
      collateralToken,
      loanToken,
      borrowedAmount,
      borrowedAmountUsd,
    })
    upserted++
  }
  return upserted
}

const marketManagerAbi = [
  {
    type: 'function',
    name: 'queryTokensListed',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address[]', name: 'cTokens' }],
  },
] as const

const erc20DecimalsAbi = [
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
] as const

const erc4626AssetAbi = [
  {
    type: 'function',
    name: 'asset',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
] as const

const curvanceDebtAbi = [
  {
    type: 'function',
    name: 'marketOutstandingDebt',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'totalBorrows',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
] as const

async function readErc20Decimals(
  client: ReturnType<typeof createMonadPublicClient>,
  token: string,
): Promise<number> {
  const addr = normalizeAddress(token)
  try {
    const d = await client.readContract({
      address: addr as `0x${string}`,
      abi: erc20DecimalsAbi,
      functionName: 'decimals',
    })
    return Number(d)
  } catch {
    return 18
  }
}

async function readCurvanceOutstandingDebt(
  client: ReturnType<typeof createMonadPublicClient>,
  cToken: `0x${string}`,
): Promise<bigint | null> {
  for (const fn of ['marketOutstandingDebt', 'totalBorrows'] as const) {
    try {
      const v = await client.readContract({
        address: cToken,
        abi: curvanceDebtAbi,
        functionName: fn,
      })
      return v as bigint
    } catch {
      /* try next */
    }
  }
  return null
}

function parseCurvanceMarketManagers(env: Env): string[] {
  const raw = env.CURVANCE_WMON_MARKET_MANAGERS?.trim()
  if (!raw) return [...DEFAULT_CURVANCE_WMON_COLLATERAL_MARKET_MANAGERS]
  return raw
    .split(',')
    .map((s) => normalizeAddress(s.trim()))
    .filter(Boolean)
}

/**
 * Curvance: isolated markets where WMON is one leg — we only snapshot managers documented as **WMON / stable** pairs
 * (WMON posted as collateral, debt in the other asset). See Curvance Monad contract addresses.
 */
export async function runCurvanceLendingSnapshot(params: {
  env: Env
  db: Pool
  snapshotTs: string
}): Promise<number> {
  const { env, db, snapshotTs } = params
  const client = createMonadPublicClient(env)
  const managers = parseCurvanceMarketManagers(env)
  let upserted = 0

  for (const manager of managers) {
    let cTokens: readonly `0x${string}`[]
    try {
      cTokens = await client.readContract({
        address: manager as `0x${string}`,
        abi: marketManagerAbi,
        functionName: 'queryTokensListed',
      })
    } catch (err) {
      console.warn(`lending: curvance market manager ${manager} queryTokensListed failed`, err)
      continue
    }

    const hasWmon = (
      await Promise.all(
        cTokens.map(async (ct) => {
          try {
            const asset = await client.readContract({
              address: ct,
              abi: erc4626AssetAbi,
              functionName: 'asset',
            })
            return normalizeAddress(String(asset)) === normalizeAddress(WMON)
          } catch {
            return false
          }
        }),
      )
    ).some(Boolean)

    if (!hasWmon) {
      console.warn(
        `lending: curvance manager ${manager} skipped (no cToken with asset() === WMON in queryTokensListed)`,
      )
      continue
    }

    for (const ct of cTokens) {
      let underlying: string
      try {
        const asset = await client.readContract({
          address: ct,
          abi: erc4626AssetAbi,
          functionName: 'asset',
        })
        underlying = normalizeAddress(String(asset))
      } catch {
        continue
      }

      if (underlying === normalizeAddress(WMON)) continue

      const debt = await readCurvanceOutstandingDebt(client, ct)
      if (debt == null || debt <= 0n) continue

      const loanDecimals = await readErc20Decimals(client, underlying)
      const borrowedAmount = formatUnits(debt, loanDecimals)
      const borrowedAmountUsd = await borrowedUsdFromDbPrice(db, underlying, debt, loanDecimals)

      await upsertLendMarketCollateralSnapshot(db, {
        timestamp: snapshotTs,
        protocol: 'curvance',
        marketId: `${manager}:${underlying}`,
        collateralToken: normalizeAddress(WMON),
        loanToken: underlying,
        borrowedAmount,
        borrowedAmountUsd,
      })
      upserted++
    }
  }

  return upserted
}

function reserveIdUnderlying(reserveId: string): string {
  const i = reserveId.indexOf('-')
  if (i <= 0) return normalizeAddress(reserveId)
  return normalizeAddress(reserveId.slice(0, i))
}

type NeverlandGraphUser = { user_id: string }

async function neverlandGraphql(
  url: string,
  body: Record<string, unknown>,
  adminSecret?: string,
): Promise<any> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (adminSecret) headers['x-hasura-admin-secret'] = adminSecret

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Neverland graphql HTTP ${res.status}`)
  const json: any = await res.json()
  if (json.errors?.length) throw new Error(JSON.stringify(json.errors))
  return json.data
}

/**
 * Neverland (Aave v3–style): aggregate **borrow-side** debt for users that enabled WMON as collateral.
 * Requires a HyperIndex/Hasura GraphQL endpoint (same schema as neverland-hyperindex) via `NEVERLAND_LENDING_GRAPHQL_URL`.
 */
export async function runNeverlandLendingSnapshot(params: {
  env: Env
  db: Pool
  snapshotTs: string
}): Promise<number> {
  const { env, db, snapshotTs } = params
  const url = env.NEVERLAND_LENDING_GRAPHQL_URL?.trim()
  if (!url) {
    console.log(
      'lending: neverland skipped (set NEVERLAND_LENDING_GRAPHQL_URL to a Neverland HyperIndex GraphQL endpoint)',
    )
    return 0
  }

  const adminSecret = env.NEVERLAND_LENDING_GRAPHQL_SECRET?.trim()
  const pageSize = env.NEVERLAND_LENDING_GRAPHQL_PAGE_SIZE
  const maxUsers = env.NEVERLAND_LENDING_GRAPHQL_MAX_USERS

  const wmonLike = `${normalizeAddress(WMON)}-%`

  const users = new Set<string>()
  for (let offset = 0; users.size < maxUsers; offset += pageSize) {
    const data = await neverlandGraphql(
      url,
      {
        query: `
          query WmonCollateralUsers($like: String!, $limit: Int!, $offset: Int!) {
            UserReserve(
              where: {
                usageAsCollateralEnabledOnUser: { _eq: true }
                reserve_id: { _ilike: $like }
              }
              limit: $limit
              offset: $offset
            ) {
              user_id
            }
          }
        `,
        variables: { like: wmonLike, limit: pageSize, offset },
      },
      adminSecret,
    )

    const batch = (data?.UserReserve ?? []) as NeverlandGraphUser[]
    if (batch.length === 0) break
    for (const row of batch) {
      if (row.user_id) users.add(normalizeAddress(row.user_id))
      if (users.size >= maxUsers) break
    }
    if (batch.length < pageSize) break
  }

  if (users.size === 0) {
    console.log('lending: neverland found 0 users with WMON collateral flag')
    return 0
  }

  const userList = [...users]
  const chunks: string[][] = []
  for (let i = 0; i < userList.length; i += 200) chunks.push(userList.slice(i, i + 200))

  type Bucket = { sum: bigint; decimals: number }
  const byLoan = new Map<string, Bucket>()
  const rpc = createMonadPublicClient(env)

  for (const chunk of chunks) {
    const data = await neverlandGraphql(
      url,
      {
        query: `
          query Debts($users: [String!]!) {
            UserReserve(
              where: { user_id: { _in: $users }, currentTotalDebt: { _gt: "0" } }
            ) {
              currentTotalDebt
              reserve_id
            }
          }
        `,
        variables: { users: chunk },
      },
      adminSecret,
    )

    const rows = (data?.UserReserve ?? []) as Array<{
      currentTotalDebt: string
      reserve_id: string
    }>
    for (const row of rows) {
      const loanUnderlying = reserveIdUnderlying(row.reserve_id)
      if (loanUnderlying === normalizeAddress(WMON) || loanUnderlying === MON_NATIVE) {
        /* still debt denominated in WMON / MON */
      }
      let raw: bigint
      try {
        raw = BigInt(String(row.currentTotalDebt).split('.')[0])
      } catch {
        console.warn('lending: neverland skip row with non-integer currentTotalDebt', row.currentTotalDebt)
        continue
      }
      if (raw <= 0n) continue

      const prev = byLoan.get(loanUnderlying) ?? { sum: 0n, decimals: 18 }
      prev.sum += raw
      byLoan.set(loanUnderlying, prev)
    }
  }

  let upserted = 0
  const marketId = 'neverland:pool'

  for (const [loanToken, agg] of byLoan) {
    const loanDecimals = await readErc20Decimals(rpc, loanToken)
    agg.decimals = loanDecimals
    const borrowedAmount = formatUnits(agg.sum, loanDecimals)
    const borrowedAmountUsd = await borrowedUsdFromDbPrice(db, loanToken, agg.sum, loanDecimals)

    await upsertLendMarketCollateralSnapshot(db, {
      timestamp: snapshotTs,
      protocol: 'neverland',
      marketId,
      collateralToken: normalizeAddress(WMON),
      loanToken,
      borrowedAmount,
      borrowedAmountUsd,
    })
    upserted++
  }

  return upserted
}

export async function runGearboxLendingSnapshot(_params: {
  env: Env
  db: Pool
  snapshotTs: string
}): Promise<number> {
  void _params
  console.log(
    'lending: gearbox skipped (no public indexed API wired yet; set GEARBOX_LENDING_GRAPHQL_URL when available)',
  )
  return 0
}

export async function runEulerLendingSnapshot(_params: {
  env: Env
  db: Pool
  snapshotTs: string
}): Promise<number> {
  void _params
  console.log(
    'lending: euler skipped (no public Monad lens/subgraph URL wired yet; set EULER_LENDING_GRAPHQL_URL when available)',
  )
  return 0
}

/**
 * Lending snapshot job: Morpho (GraphQL) + Curvance (on-chain) + optional Neverland (GraphQL) + placeholders.
 */
export async function runLendingSnapshot(params: { env: Env; db: Pool; snapshotTs?: string }) {
  const { env, db, snapshotTs } = params
  const nowIso = snapshotTs ?? new Date().toISOString()

  try {
    const morphoN = await runMorphoLendingSnapshot({ env, db, snapshotTs: nowIso })
    console.log(`lending: upserted ${morphoN} Morpho markets`)
  } catch (err) {
    console.error('lending: morpho failed', err)
  }

  try {
    const curvanceN = await runCurvanceLendingSnapshot({ env, db, snapshotTs: nowIso })
    console.log(`lending: upserted ${curvanceN} Curvance loan totals`)
  } catch (err) {
    console.error('lending: curvance failed', err)
  }

  try {
    const neverlandN = await runNeverlandLendingSnapshot({ env, db, snapshotTs: nowIso })
    console.log(`lending: upserted ${neverlandN} Neverland loan totals (WMON-collateral users)`)
  } catch (err) {
    console.error('lending: neverland failed', err)
  }

  try {
    await runGearboxLendingSnapshot({ env, db, snapshotTs: nowIso })
  } catch (err) {
    console.error('lending: gearbox failed', err)
  }

  try {
    await runEulerLendingSnapshot({ env, db, snapshotTs: nowIso })
  } catch (err) {
    console.error('lending: euler failed', err)
  }
}
