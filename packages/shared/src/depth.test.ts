import { uniswapV3BandAmountsRaw } from "./depth.js";
import {
  integerSqrt,
  uniswapV3DirectionalMaxOutputRaw,
} from "./depth.js";

describe("uniswapV3BandAmountsRaw", () => {
  it("returns 0 for bandBps=0", () => {
    const out = uniswapV3BandAmountsRaw({
      liquidity: 1_000_000n,
      sqrtPriceX96: 2n ** 96n,
      bandBps: 0,
    });
    expect(out.amount0).toBe(0n);
    expect(out.amount1).toBe(0n);
  });

  it("grows amounts with bandBps", () => {
    const base = uniswapV3BandAmountsRaw({
      liquidity: 1_000_000n,
      sqrtPriceX96: 2n ** 96n,
      bandBps: 100,
    });
    const wider = uniswapV3BandAmountsRaw({
      liquidity: 1_000_000n,
      sqrtPriceX96: 2n ** 96n,
      bandBps: 500,
    });
    expect(wider.amount0).toBeGreaterThan(base.amount0);
    expect(wider.amount1).toBeGreaterThan(base.amount1);
  });
});

describe("uniswapV3DirectionalMaxOutputRaw", () => {
  it("matches directional formulas for a simple symmetric case", () => {
    const liquidity = 1_000_000n;
    const sqrtPriceX96 = 2n ** 96n;
    const bandBps = 100; // 1%

    const denom = 10000n;
    const band = BigInt(bandBps);
    const sqrtPrice2 = sqrtPriceX96 * sqrtPriceX96;

    const sqrtLowerX96 = integerSqrt((sqrtPrice2 * (denom - band)) / denom);
    const sqrtUpperX96 = integerSqrt((sqrtPrice2 * (denom + band)) / denom);
    const Q96 = 2n ** 96n;

    const expectedToken0to1 = (liquidity * (sqrtPriceX96 - sqrtLowerX96)) / Q96;
    const expectedToken1to0 =
      (liquidity * (sqrtUpperX96 - sqrtPriceX96) * Q96) / (sqrtUpperX96 * sqrtPriceX96);

    const actualToken0to1 = uniswapV3DirectionalMaxOutputRaw({
      liquidity,
      sqrtPriceX96,
      bandBps,
      direction: "token0to1",
    });
    const actualToken1to0 = uniswapV3DirectionalMaxOutputRaw({
      liquidity,
      sqrtPriceX96,
      bandBps,
      direction: "token1to0",
    });

    expect(actualToken0to1).toBe(expectedToken0to1);
    expect(actualToken1to0).toBe(expectedToken1to0);
  });

  it("grows with bandBps for both directions", () => {
    const liquidity = 1_000_000n;
    const sqrtPriceX96 = 2n ** 96n; // keep deltas comfortably above rounding floors

    const a = uniswapV3DirectionalMaxOutputRaw({
      liquidity,
      sqrtPriceX96,
      bandBps: 100,
      direction: "token0to1",
    });
    const b = uniswapV3DirectionalMaxOutputRaw({
      liquidity,
      sqrtPriceX96,
      bandBps: 500,
      direction: "token0to1",
    });
    expect(b).toBeGreaterThan(a);

    const c = uniswapV3DirectionalMaxOutputRaw({
      liquidity,
      sqrtPriceX96,
      bandBps: 100,
      direction: "token1to0",
    });
    const d = uniswapV3DirectionalMaxOutputRaw({
      liquidity,
      sqrtPriceX96,
      bandBps: 2000,
      direction: "token1to0",
    });
    expect(d).toBeGreaterThan(c);
  });
});

