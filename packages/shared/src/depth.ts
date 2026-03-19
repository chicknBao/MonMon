const Q96 = 2n ** 96n;

/**
 * Integer sqrt using Newton's method (floor).
 * - Works for bigints
 * - No floating point / approximation.
 */
export function integerSqrt(n: bigint): bigint {
  if (n < 0n) throw new Error("integerSqrt: n must be >= 0");
  if (n < 2n) return n;

  // Initial guess: n/2
  let x0 = n;
  let x1 = (n + 1n) / 2n;
  while (x1 < x0) {
    x0 = x1;
    x1 = (n / x0 + x0) / 2n;
  }
  return x0;
}

function ensureSorted(a: bigint, b: bigint): [bigint, bigint] {
  return a <= b ? [a, b] : [b, a];
}

/**
 * MVP approximation of Uniswap v3 "depth within price band" by assuming the
 * current active liquidity is available across the band.
 *
 * This uses a linear approximation for sqrt(1 +/- band) to avoid expensive
 * square roots with integer math.
 */
export function uniswapV3BandAmountsRaw(params: {
  liquidity: bigint;
  sqrtPriceX96: bigint;
  bandBps: number;
}): { amount0: bigint; amount1: bigint; sqrtLowerX96: bigint; sqrtUpperX96: bigint } {
  const { liquidity, sqrtPriceX96, bandBps } = params;
  if (bandBps <= 0) {
    return {
      amount0: 0n,
      amount1: 0n,
      sqrtLowerX96: sqrtPriceX96,
      sqrtUpperX96: sqrtPriceX96,
    };
  }
  if (bandBps >= 20000) {
    throw new Error("bandBps must be < 20000 for this approximation");
  }

  // sqrt(1 +/- x) ~ 1 +/- x/2 for small x; with x=band/10000 => multiplier ~ 1 +/- band/20000
  const band = BigInt(bandBps);
  const denom = 20000n;
  const sqrtLowerX96 = (sqrtPriceX96 * (denom - band)) / denom;
  const sqrtUpperX96 = (sqrtPriceX96 * (denom + band)) / denom;

  const [a, b] = ensureSorted(sqrtLowerX96, sqrtUpperX96);
  if (a === 0n) {
    return { amount0: 0n, amount1: 0n, sqrtLowerX96, sqrtUpperX96 };
  }

  // Uniswap v3 formulas (with Q96 fixed point):
  // amount0 = L * (sqrtB - sqrtA) * Q96 / (sqrtB * sqrtA)
  // amount1 = L * (sqrtB - sqrtA) / Q96
  const delta = b - a;
  const amount0 = (liquidity * delta * Q96) / (b * a);
  const amount1 = (liquidity * delta) / Q96;

  return { amount0, amount1, sqrtLowerX96: a, sqrtUpperX96: b };
}

/**
 * Directional "max output within a price-space band" assuming constant active liquidity.
 *
 * This is exact about:
 * - converting the ±% band into sqrt bounds
 * - using the exact Uniswap v3 amount formulas between sqrt bounds
 *
 * This is NOT a full tick-walk integration (liquidity changes across initialized ticks),
 * so it's more accurate than the MVP linearized sqrt approximation, but still an MVP-level
 * approximation of how liquidity is distributed across the band.
 */
export function uniswapV3DirectionalMaxOutputRaw(params: {
  liquidity: bigint;
  sqrtPriceX96: bigint;
  bandBps: number; // price-space band in bps of current price
  direction: "token0to1" | "token1to0";
}): bigint {
  const { liquidity, sqrtPriceX96, bandBps, direction } = params;
  if (bandBps <= 0) return 0n;
  if (bandBps >= 10000) throw new Error("bandBps must be < 10000 for price-space band");
  if (liquidity <= 0n) return 0n;

  const denom = 10000n;
  const band = BigInt(bandBps);
  const sqrtPrice2 = sqrtPriceX96 * sqrtPriceX96; // Q192 scaled price

  // Exact sqrt bounds from price-space ±p%.
  const sqrtLowerX96 = integerSqrt((sqrtPrice2 * (denom - band)) / denom);
  const sqrtUpperX96 = integerSqrt((sqrtPrice2 * (denom + band)) / denom);

  if (direction === "token0to1") {
    // Exact input token0 -> token1 decreases sqrtPrice (token1/token0),
    // so token1 out corresponds to moving from sqrtPrice down to sqrtLower.
    const a = sqrtLowerX96;
    const b = sqrtPriceX96;
    if (b <= a) return 0n;
    return (liquidity * (b - a)) / Q96; // amount1 for [sqrtLower, sqrtPrice]
  }

  // direction === "token1to0": exact input token1 -> token0 increases sqrtPrice,
  // so token0 out corresponds to moving from sqrtPrice up to sqrtUpper.
  const a = sqrtPriceX96;
  const b = sqrtUpperX96;
  if (a === 0n || b <= a) return 0n;
  return (liquidity * (b - a) * Q96) / (b * a); // amount0 for [sqrtPrice, sqrtUpper]
}

export function formatUnits(raw: bigint, decimals: number): string {
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  const div = 10n ** BigInt(decimals);
  const whole = abs / div;
  const frac = abs % div;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  const out = fracStr.length ? `${whole.toString()}.${fracStr}` : whole.toString();
  return neg ? `-${out}` : out;
}

