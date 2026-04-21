import type { Pool } from "pg";
import type { Env } from "../config.js";
import { createMonadPublicClient } from "../monadPublicClient.js";

/** Curvance WMON/USDC cUSDC from docs — probe debtCaps getter. */
const SAMPLE_DEBT_CTOKEN = "0x8ee9fc28b8da872c38a496e9ddb9700bb7261774" as const;

const debtCapsAbi = [
  {
    type: "function",
    name: "debtCaps",
    stateMutability: "view",
    inputs: [{ type: "address", name: "" }],
    outputs: [{ type: "uint256", name: "" }],
  },
] as const;

/**
 * Read-only probe: logs cToken debt cap if the MarketManager exposes `debtCaps`.
 */
export async function runCurvanceDebtCapProbe(params: { env: Env; db: Pool }): Promise<void> {
  void params.db;
  const client = createMonadPublicClient(params.env);
  const manager = "0xa6a2a92f126b79ee0804845ee6b52899b4491093" as `0x${string}`;
  try {
    const cap = await client.readContract({
      address: manager,
      abi: debtCapsAbi,
      functionName: "debtCaps",
      args: [SAMPLE_DEBT_CTOKEN],
    });
    console.log(`curvance-probe: debtCaps(cUSDC)=${String(cap)} (raw units)`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`curvance-probe: debtCaps read failed: ${msg}`);
  }
}
