import type { Pool } from "pg";
import type { Env } from "../config.js";
import { runUniswapV3DepthSnapshot } from "../dexes/uniswapV3.js";
import { runUniswapV4DepthSnapshot } from "../dexes/uniswapV4.js";
import { runCurveDepthSnapshot } from "../dexes/curve.js";
import { runLfjDepthSnapshot } from "../dexes/lfj.js";
import { runPancakeDepthSnapshot } from "../dexes/pancake.js";
import { runBalancerDepthSnapshot } from "../dexes/balancer.js";
import { runLendingSnapshot } from "./lendingSnapshot.js";
import { runMorphoAtRiskSnapshot } from "./morphoAtRiskSnapshot.js";
import { runDashboardRollup } from "./dashboardRollup.js";
import { runNeverlandSchemaProbe } from "./neverlandSchemaProbe.js";
import { runCurvanceDebtCapProbe } from "./curvanceDebtCapProbe.js";

export async function runSnapshot(params: { env: Env; db: Pool }) {
  const { env, db } = params;
  const snapshotTs = new Date().toISOString();

  // MVP order: implement Uniswap v3 first.
  try {
    await runUniswapV3DepthSnapshot({ env, db, snapshotTs });
  } catch (err) {
    console.error("snapshot: uniswap_v3 failed", err);
  }

  try {
    await runUniswapV4DepthSnapshot({ env, db, snapshotTs });
  } catch (err) {
    console.error("snapshot: uniswap_v4 failed", err);
  }

  try {
    await runCurveDepthSnapshot({ env, db, snapshotTs });
  } catch (err) {
    console.error("snapshot: curve failed", err);
  }

  try {
    await runLfjDepthSnapshot({ env, db, snapshotTs });
  } catch (err) {
    console.error("snapshot: lfj failed", err);
  }

  try {
    await runPancakeDepthSnapshot({ env, db, snapshotTs });
  } catch (err) {
    console.error("snapshot: pancake failed", err);
  }

  try {
    await runBalancerDepthSnapshot({ env, db, snapshotTs });
  } catch (err) {
    console.error("snapshot: balancer failed", err);
  }

  try {
    await runLendingSnapshot({ env, db, snapshotTs });
  } catch (err) {
    console.error("snapshot: lending failed", err);
  }

  try {
    await runMorphoAtRiskSnapshot({ env, db, snapshotTs });
  } catch (err) {
    console.error("snapshot: morpho-at-risk failed", err);
  }

  try {
    await runDashboardRollup({ env, db, snapshotTs });
  } catch (err) {
    console.error("snapshot: dashboard rollup failed", err);
  }

  try {
    await runNeverlandSchemaProbe(env);
  } catch (err) {
    console.error("snapshot: neverland probe failed", err);
  }

  try {
    await runCurvanceDebtCapProbe({ env, db });
  } catch (err) {
    console.error("snapshot: curvance probe failed", err);
  }
}

