import "dotenv/config";
import express from "express";
import cors from "cors";
import { loadEnv } from "./config";
import { createDb } from "./db";
import { registerRoutes } from "./routes";

async function main() {
  const env = loadEnv();
  const db = createDb(env);
  const app = express();
  app.use(cors());
  app.use(express.json());

  registerRoutes(app, db);

  app.listen(env.PORT, () => {
    console.log(`api listening on :${env.PORT}`);
  });

  // Keep db alive for request pooling.
  void db;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

