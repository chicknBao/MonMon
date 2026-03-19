import "dotenv/config";
import { loadEnv } from "./config.js";
import { createDb } from "./db.js";
import { runSnapshot } from "./jobs/snapshot.js";

async function main() {
  const env = loadEnv();
  const db = createDb(env);
  await runSnapshot({ env, db });
  await db.end().catch(() => undefined);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

