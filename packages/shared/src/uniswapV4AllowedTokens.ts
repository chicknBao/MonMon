/**
 * Token symbols allowed for Uniswap v4 pool filtering.
 * Pools are included only when both pool tokens are in this set.
 */
export const UNISWAP_V4_ALLOWED_TOKEN_SYMBOLS = [
  "MON",
  "ETH",
  "USDC",
  "AUSD",
  "XAUT0",
  "WBTC",
  "CBBTC",
  "GMON",
  "SMON",
  "WSTETH",
  "WEETH",
  "SHMON",
] as const;

export type UniswapV4AllowedSymbol = (typeof UNISWAP_V4_ALLOWED_TOKEN_SYMBOLS)[number];

const ALLOWED_SET = new Set<string>(
  UNISWAP_V4_ALLOWED_TOKEN_SYMBOLS.map((s) => s.toUpperCase()),
);

export function isUniswapV4AllowedToken(symbol: string): boolean {
  return ALLOWED_SET.has(String(symbol).toUpperCase());
}

export function isUniswapV4PoolAllowed(symbol0: string, symbol1: string): boolean {
  return isUniswapV4AllowedToken(symbol0) && isUniswapV4AllowedToken(symbol1);
}
