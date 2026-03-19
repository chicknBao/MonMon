import type { Pool } from "pg";
import type { Env } from "../config.js";
import { runUniswapV3DepthSnapshot } from "../dexes/uniswapV3.js";
import { runCurveDepthSnapshot } from "../dexes/curve.js";
import { runLfjDepthSnapshot } from "../dexes/lfj.js";
import { runBalancerDepthSnapshot } from "../dexes/balancer.js";

export async function runSnapshot(params: { env: Env; db: Pool }) {
  const { env, db } = params;

  // MVP order: implement Uniswap v3 first.
  await runUniswapV3DepthSnapshot({ env, db });
  await runCurveDepthSnapshot({ env, db });
  await runLfjDepthSnapshot({ env, db });
  await runBalancerDepthSnapshot({ env, db });
}

