import type { Pool } from "pg";
import type { Env } from "../config.js";
import { runUniswapV3DepthSnapshot } from "../dexes/uniswapV3.js";
import { runUniswapV4DepthSnapshot } from "../dexes/uniswapV4.js";
import { runCurveDepthSnapshot } from "../dexes/curve.js";
import { runLfjDepthSnapshot } from "../dexes/lfj.js";
import { runBalancerDepthSnapshot } from "../dexes/balancer.js";

export async function runSnapshot(params: { env: Env; db: Pool }) {
  const { env, db } = params;

  // MVP order: implement Uniswap v3 first.
  try {
    await runUniswapV3DepthSnapshot({ env, db });
  } catch (err) {
    console.error("snapshot: uniswap_v3 failed", err);
  }

  try {
    await runUniswapV4DepthSnapshot({ env, db });
  } catch (err) {
    console.error("snapshot: uniswap_v4 failed", err);
  }

  try {
    await runCurveDepthSnapshot({ env, db });
  } catch (err) {
    console.error("snapshot: curve failed", err);
  }

  try {
    await runLfjDepthSnapshot({ env, db });
  } catch (err) {
    console.error("snapshot: lfj failed", err);
  }

  try {
    await runBalancerDepthSnapshot({ env, db });
  } catch (err) {
    console.error("snapshot: balancer failed", err);
  }
}

