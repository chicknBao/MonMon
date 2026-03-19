import cron from "node-cron";
import type { Pool } from "pg";
import type { Env } from "./config.js";
import { runSnapshot } from "./jobs/snapshot.js";

export function startSnapshotScheduler(params: { env: Env; db: Pool }) {
  const { env, db } = params;
  const expr = env.SNAPSHOT_CRON_SCHEDULE;
  if (!expr) return;

  let running = false;

  cron.schedule(
    expr,
    async () => {
      if (running) {
        console.log("snapshot scheduler: previous run still in progress, skipping");
        return;
      }
      running = true;
      try {
        console.log(`snapshot scheduler: running snapshot @ ${new Date().toISOString()}`);
        await runSnapshot({ env, db });
      } catch (err) {
        console.error("snapshot scheduler run failed", err);
      } finally {
        running = false;
      }
    },
    { timezone: env.SNAPSHOT_TIMEZONE ?? "UTC" },
  );

  console.log(`snapshot scheduler enabled: cron="${expr}" tz="${env.SNAPSHOT_TIMEZONE ?? "UTC"}"`);
}

