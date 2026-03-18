import type { Pool } from "pg";
import type { Env } from "../config";
import { runUniswapV3DepthSnapshot } from "../dexes/uniswapV3";
import { runCurveDepthSnapshot } from "../dexes/curve";
import { runLfjDepthSnapshot } from "../dexes/lfj";
import { runBalancerDepthSnapshot } from "../dexes/balancer";

export async function runSnapshot(params: { env: Env; db: Pool }) {
  const { env, db } = params;

  // MVP order: implement Uniswap v3 first.
  await runUniswapV3DepthSnapshot({ env, db });
  await runCurveDepthSnapshot({ env, db });
  await runLfjDepthSnapshot({ env, db });
  await runBalancerDepthSnapshot({ env, db });
}

