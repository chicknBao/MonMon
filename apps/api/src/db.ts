import { Pool } from "pg";
import type { Env } from "./config";

export function createDb(env: Env): Pool {
  return new Pool({
    connectionString: env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
  });
}

