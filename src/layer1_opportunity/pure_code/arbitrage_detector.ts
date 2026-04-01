import { Connection, PublicKey } from "@solana/web3.js";
import { logger } from "../../utils/logger";
import { getConfig, getStrategyConfig } from "../../utils/config";

export interface ArbOpportunity {
  type: "arbitrage";
  path: string;           // e.g. "pool1→pool3" or "pool1→pool2→pool3"
  tokenIn: string;
  tokenOut: string;
  amountIn: number;
  expectedProfit: number;
  profitPercent: number;
  pools: PoolState[];
  timestamp: number;
}

export interface PoolState {
  name: string;
  address: string;
  tokenAVault: string;
  tokenBVault: string;
  reserveA: number;
  reserveB: number;
  price: number;          // tokenA per tokenB
}

export class ArbitrageDetector {
  private connection: Connection;
  private minProfitPercent: number;

  constructor(connection: Connection, minProfitPercent?: number) {
    this.connection = connection;
    const strategyCfg = getStrategyConfig();
    this.minProfitPercent = minProfitPercent ?? strategyCfg.strategies.crypto_arbitrage.min_profit_pct;
  }

  // Calculate output using constant product formula — fee from config
  private calculateOutput(amountIn: number, reserveIn: number, reserveOut: number): number {
    const cfg = getConfig();
    const amountInWithFee = amountIn * cfg.amm.fee_numerator;
    const numerator = amountInWithFee * reserveOut;
    const denominator = reserveIn * cfg.amm.fee_denominator + amountInWithFee;
    return numerator / denominator;
  }

  // Fetch current pool state from on-chain vault balances
  async getPoolState(pool: {
    name: string;
    address: string;
    tokenAVault: string;
    tokenBVault: string;
  }): Promise<PoolState> {
    const vaultA = await this.connection.getTokenAccountBalance(
      new PublicKey(pool.tokenAVault)
    );
    const vaultB = await this.connection.getTokenAccountBalance(
      new PublicKey(pool.tokenBVault)
    );

    const reserveA = parseFloat(vaultA.value.uiAmountString!);
    const reserveB = parseFloat(vaultB.value.uiAmountString!);

    return {
      name: pool.name,
      address: pool.address,
      tokenAVault: pool.tokenAVault,
      tokenBVault: pool.tokenBVault,
      reserveA,
      reserveB,
      price: reserveA / reserveB,
    };
  }

  // Check direct arb: buy on pool1, sell on pool2
  checkDirectArb(
    poolBuy: PoolState,
    poolSell: PoolState,
    amountIn: number,
    buyAtoB: boolean
  ): ArbOpportunity | null {
    // Buy on poolBuy
    let amountMid: number;
    if (buyAtoB) {
      amountMid = this.calculateOutput(amountIn, poolBuy.reserveA, poolBuy.reserveB);
    } else {
      amountMid = this.calculateOutput(amountIn, poolBuy.reserveB, poolBuy.reserveA);
    }

    // Sell on poolSell (reverse direction)
    let amountOut: number;
    if (buyAtoB) {
      amountOut = this.calculateOutput(amountMid, poolSell.reserveB, poolSell.reserveA);
    } else {
      amountOut = this.calculateOutput(amountMid, poolSell.reserveA, poolSell.reserveB);
    }

    const profit = amountOut - amountIn;
    const profitPercent = (profit / amountIn) * 100;

    if (profitPercent >= this.minProfitPercent) {
      return {
        type: "arbitrage",
        path: `${poolBuy.name}→${poolSell.name}`,
        tokenIn: buyAtoB ? "tokenA" : "tokenB",
        tokenOut: buyAtoB ? "tokenA" : "tokenB",
        amountIn,
        expectedProfit: profit,
        profitPercent,
        pools: [poolBuy, poolSell],
        timestamp: Date.now(),
      };
    }

    return null;
  }

  // Check triangular arb: token1 → token2 → token3 → token1
  checkTriangularArb(
    pool1: PoolState,  // token1/token2
    pool2: PoolState,  // token2/token3
    pool3: PoolState,  // token1/token3
    amountIn: number
  ): ArbOpportunity | null {
    // Path: fUSDC → fSOL (pool1) → fRAY (pool2) → fUSDC (pool3)
    const step1Out = this.calculateOutput(amountIn, pool1.reserveA, pool1.reserveB);
    const step2Out = this.calculateOutput(step1Out, pool2.reserveA, pool2.reserveB);
    const step3Out = this.calculateOutput(step2Out, pool3.reserveB, pool3.reserveA);

    const profit = step3Out - amountIn;
    const profitPercent = (profit / amountIn) * 100;

    if (profitPercent >= this.minProfitPercent) {
      return {
        type: "arbitrage",
        path: `${pool1.name}→${pool2.name}→${pool3.name}`,
        tokenIn: "fUSDC",
        tokenOut: "fUSDC",
        amountIn,
        expectedProfit: profit,
        profitPercent,
        pools: [pool1, pool2, pool3],
        timestamp: Date.now(),
      };
    }

    // Try reverse: fUSDC → fRAY (pool3) → fSOL (pool2) → fUSDC (pool1)
    const rev1Out = this.calculateOutput(amountIn, pool3.reserveA, pool3.reserveB);
    const rev2Out = this.calculateOutput(rev1Out, pool2.reserveB, pool2.reserveA);
    const rev3Out = this.calculateOutput(rev2Out, pool1.reserveB, pool1.reserveA);

    const revProfit = rev3Out - amountIn;
    const revProfitPercent = (revProfit / amountIn) * 100;

    if (revProfitPercent >= this.minProfitPercent) {
      return {
        type: "arbitrage",
        path: `${pool3.name}→${pool2.name}→${pool1.name} (reverse)`,
        tokenIn: "fUSDC",
        tokenOut: "fUSDC",
        amountIn,
        expectedProfit: revProfit,
        profitPercent: revProfitPercent,
        pools: [pool3, pool2, pool1],
        timestamp: Date.now(),
      };
    }

    return null;
  }

  // Scan all pools for any arb opportunity
  async scan(pools: any, testAmounts: number[] = [100, 500, 1000, 5000]): Promise<ArbOpportunity[]> {
    const opportunities: ArbOpportunity[] = [];

    const pool1State = await this.getPoolState(pools.pool1);
    const pool2State = await this.getPoolState(pools.pool2);
    const pool3State = await this.getPoolState(pools.pool3);

    logger.info({
      pool1_price: pool1State.price.toFixed(4),
      pool2_price: pool2State.price.toFixed(4),
      pool3_price: pool3State.price.toFixed(4),
    }, "Current pool prices");

    for (const amount of testAmounts) {
      // Triangular arb
      const triArb = this.checkTriangularArb(pool1State, pool2State, pool3State, amount);
      if (triArb) {
        opportunities.push(triArb);
        logger.info({
          path: triArb.path,
          amountIn: amount,
          profit: triArb.expectedProfit.toFixed(4),
          profitPercent: triArb.profitPercent.toFixed(2) + "%",
        }, "ARB FOUND");
      }
    }

    if (opportunities.length === 0) {
      logger.info("No profitable arbitrage opportunities found");
    }

    return opportunities;
  }
}