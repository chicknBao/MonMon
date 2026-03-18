export type DexName = "uniswap_v3" | "curve" | "balancer" | "lfj";

export type TokenDepthSnapshot = {
  timestamp: string; // ISO
  dex: DexName;
  tokenAddress: string;
  depthSimple: string; // numeric as string to avoid JS bigint/float issues
  depthBand: string; // numeric as string
  bandBps: number;
};

export type PoolSnapshot = {
  timestamp: string;
  dex: DexName;
  poolAddress: string;
  // token amounts in raw units (as decimal strings)
  // For multi-token pools, this is a map from token -> amount.
  tokenAmounts: Record<string, string>;
  // Spot USD prices per token (if known); used to compute token depth in USD.
  tokenPricesUsd?: Record<string, string>;
};

