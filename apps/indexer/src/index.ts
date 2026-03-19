import "dotenv/config";
import { loadEnv } from "./config.js";
import { createDb } from "./db.js";
import { runSnapshot } from "./jobs/snapshot.js";
import { startSnapshotScheduler } from "./scheduler.js";
import { migrateDb } from "./migrate.js";

async function main() {
  const env = loadEnv();
  const db = createDb(env);
  const isScheduled = Boolean(env.SNAPSHOT_CRON_SCHEDULE);
  try {
    await migrateDb(db);
    await runSnapshot({ env, db });
    if (isScheduled) startSnapshotScheduler({ env, db });
  } finally {
    if (!isScheduled) {
      await db.end().catch(() => undefined);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

