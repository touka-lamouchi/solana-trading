import { logger } from "../utils/logger";

export interface SwapStep {
  poolAddress: string;
  tokenAVault: string;
  tokenBVault: string;
  poolName: string;
  aToB: boolean;
  expectedOutput: number;
}

export interface SwapRoute {
  steps: SwapStep[];
  tokenIn: string;
  tokenOut: string;
  amountIn: number;
  expectedFinalOutput: number;
  poolCount: number;
}

export class RoutePlanner {
  private pools: any;

  constructor(pools: any) {
    this.pools = pools;
  }

  planSingleHop(
    poolKey: string,
    amountIn: number,
    aToB: boolean,
    expectedOutput: number
  ): SwapRoute {
    const pool = this.pools[poolKey];

    const route: SwapRoute = {
      steps: [{
        poolAddress: pool.address,
        tokenAVault: pool.tokenAVault,
        tokenBVault: pool.tokenBVault,
        poolName: pool.name,
        aToB,
        expectedOutput,
      }],
      tokenIn: aToB ? pool.tokenA : pool.tokenB,
      tokenOut: aToB ? pool.tokenB : pool.tokenA,
      amountIn,
      expectedFinalOutput: expectedOutput,
      poolCount: 1,
    };

    logger.info({
      pool: pool.name,
      direction: aToB ? `${pool.tokenA}→${pool.tokenB}` : `${pool.tokenB}→${pool.tokenA}`,
      amountIn,
      expectedOutput,
    }, "Single-hop route planned");

    return route;
  }

  planTriangularArb(
    amountIn: number,
    step1Output: number,
    step2Output: number,
    step3Output: number,
    reverse: boolean = false
  ): SwapRoute {
    let steps: SwapStep[];

    if (!reverse) {
      // Forward: fUSDC → fSOL (pool1) → fRAY (pool2) → fUSDC (pool3)
      steps = [
        {
          poolAddress: this.pools.pool1.address,
          tokenAVault: this.pools.pool1.tokenAVault,
          tokenBVault: this.pools.pool1.tokenBVault,
          poolName: this.pools.pool1.name,
          aToB: true,  // fUSDC → fSOL
          expectedOutput: step1Output,
        },
        {
          poolAddress: this.pools.pool2.address,
          tokenAVault: this.pools.pool2.tokenAVault,
          tokenBVault: this.pools.pool2.tokenBVault,
          poolName: this.pools.pool2.name,
          aToB: true,  // fSOL → fRAY
          expectedOutput: step2Output,
        },
        {
          poolAddress: this.pools.pool3.address,
          tokenAVault: this.pools.pool3.tokenAVault,
          tokenBVault: this.pools.pool3.tokenBVault,
          poolName: this.pools.pool3.name,
          aToB: false,  // fRAY → fUSDC
          expectedOutput: step3Output,
        },
      ];
    } else {
      // Reverse: fUSDC → fRAY (pool3) → fSOL (pool2) → fUSDC (pool1)
      steps = [
        {
          poolAddress: this.pools.pool3.address,
          tokenAVault: this.pools.pool3.tokenAVault,
          tokenBVault: this.pools.pool3.tokenBVault,
          poolName: this.pools.pool3.name,
          aToB: true,  // fUSDC → fRAY
          expectedOutput: step1Output,
        },
        {
          poolAddress: this.pools.pool2.address,
          tokenAVault: this.pools.pool2.tokenAVault,
          tokenBVault: this.pools.pool2.tokenBVault,
          poolName: this.pools.pool2.name,
          aToB: false,  // fRAY → fSOL
          expectedOutput: step2Output,
        },
        {
          poolAddress: this.pools.pool1.address,
          tokenAVault: this.pools.pool1.tokenAVault,
          tokenBVault: this.pools.pool1.tokenBVault,
          poolName: this.pools.pool1.name,
          aToB: false,  // fSOL → fUSDC
          expectedOutput: step3Output,
        },
      ];
    }

    const route: SwapRoute = {
      steps,
      tokenIn: "fUSDC",
      tokenOut: "fUSDC",
      amountIn,
      expectedFinalOutput: step3Output,
      poolCount: 3,
    };

    logger.info({
      hops: 3,
      direction: reverse ? "reverse" : "forward",
      amountIn,
      expectedProfit: step3Output - amountIn,
      path: steps.map((s) => s.poolName).join(" → "),
    }, "Triangular arb route planned");

    return route;
  }
}