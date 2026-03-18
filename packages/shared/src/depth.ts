const Q96 = 2n ** 96n;

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

