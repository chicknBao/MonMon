import type { DexName } from "@monmon/shared";
import type { Pool } from "pg";

export type TokenMeta = {
  tokenAddress: string;
  symbol: string;
  name?: string;
  decimals: number;
};

export type PoolMeta = {
  poolAddress: string;
  dex: DexName;
  tokenAddresses: string[];
};

export async function upsertToken(db: Pool, token: TokenMeta) {
  await db.query(
    `
      INSERT INTO tokens (token_address, symbol, name, decimals)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (token_address)
      DO UPDATE SET
        symbol = EXCLUDED.symbol,
        name = EXCLUDED.name,
        decimals = EXCLUDED.decimals
    `,
    [token.tokenAddress, token.symbol, token.name ?? token.symbol, token.decimals],
  );
}

export async function upsertPool(db: Pool, pool: PoolMeta) {
  await db.query(
    `
      INSERT INTO pools (pool_address, dex, token_addresses)
      VALUES ($1, $2, $3)
      ON CONFLICT (pool_address)
      DO UPDATE SET
        dex = EXCLUDED.dex,
        token_addresses = EXCLUDED.token_addresses
    `,
    [pool.poolAddress, pool.dex, pool.tokenAddresses],
  );
}

