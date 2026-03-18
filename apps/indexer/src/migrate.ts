import fs from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import { fileURLToPath } from "node:url";

export async function migrateDb(db: Pool) {
  // db/init.sql lives at repo root
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const sqlPath = path.resolve(__dirname, "../../../db/init.sql");
  const sql = await fs.readFile(sqlPath, "utf8");

  // pg can execute multi-statement SQL in a single call for the simple query protocol.
  // If the provider disallows multi-statements, we can switch to a splitter later.
  await db.query(sql);
}

