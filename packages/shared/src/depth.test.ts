import { uniswapV3BandAmountsRaw } from "./depth";

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

