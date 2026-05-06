import { ArbOpportunity, PoolState } from "../pure_code/arbitrage_detector";
import { MempoolSignal } from "./mempool_signal";
import { logger } from "../../utils/logger";

export interface MempoolPressureConfig {
  pressureThreshold?: number;   // |pressureScore| required (default 0.5)
  minTxCount?: number;          // total tx count required (default 5)
}

/**
 * MempoolPressureDetector — predictive detector backed by MempoolSignal.
 *
 * Reads the live buy/sell pressure aggregated from on-chain swap events.
 * Emits a "mempool_pressure" opportunity when the pressureScore crosses a
 * threshold AND there's enough transaction volume to be statistically
 * meaningful (not a single-tx spike).
 *
 *   pressureScore > +threshold AND totalTx >= minTxCount → bullish
 *   pressureScore < -threshold AND totalTx >= minTxCount → bearish
 *
 * Direction:
 *   bullish → tokenIn = fUSDC, tokenOut = primary token (follow buy flow)
 *   bearish → tokenIn = primary token, tokenOut = fUSDC (follow sell flow)
 *
 * Reuses the engine's MempoolSignal — does NOT instantiate a new monitor.
 */
export class MempoolPressureDetector {
  private mempoolSignal: MempoolSignal;
  private pressureThreshold: number;
  private minTxCount: number;

  constructor(mempoolSignal: MempoolSignal, config: MempoolPressureConfig = {}) {
    this.mempoolSignal = mempoolSignal;
    this.pressureThreshold = config.pressureThreshold ?? 0.5;
    this.minTxCount = config.minTxCount ?? 5;
  }

  async scan(opts: {
    tokenMint: string;
    capital: number;
    pool: PoolState | null;
    baseTokenName?: string;
    primaryTokenName?: string;
  }): Promise<ArbOpportunity | null> {
    if (!opts.pool) return null;

    const baseTokenName = opts.baseTokenName ?? "fUSDC";
    const primaryTokenName = opts.primaryTokenName ?? "fSOL";

    const pressure = await this.mempoolSignal
      .getSignal(opts.tokenMint)
      .catch(() => null);

    if (!pressure) return null;
    if (pressure.netDirection !== "bullish" && pressure.netDirection !== "bearish") return null;

    const totalTx = pressure.buyTxCount + pressure.sellTxCount;
    if (totalTx < this.minTxCount) return null;
    if (Math.abs(pressure.pressureScore) <= this.pressureThreshold) return null;

    const isBullish = pressure.pressureScore > 0;
    const tokenIn  = isBullish ? baseTokenName    : primaryTokenName;
    const tokenOut = isBullish ? primaryTokenName : baseTokenName;

    // Profit proxy: |pressureScore| × small magnitude. Slow path computes
    // the actual expectedOut from pool reserves at execution.
    const expectedProfit = opts.capital * Math.abs(pressure.pressureScore) * 0.03;
    const profitPercent = Math.abs(pressure.pressureScore) * 3.0;

    const opp: ArbOpportunity = {
      type: "mempool_pressure",
      path: `mempool_pressure: ${pressure.netDirection} (${pressure.buyTxCount}↑/${pressure.sellTxCount}↓ tx, score ${pressure.pressureScore.toFixed(2)}) → ${primaryTokenName}`,
      tokenIn,
      tokenOut,
      amountIn: opts.capital,
      expectedProfit,
      profitPercent: parseFloat(profitPercent.toFixed(2)),
      pools: [opts.pool],
      timestamp: Date.now(),
      signalSource: "mempool_pressure_detector",
    };

    logger.info({
      mint: opts.tokenMint.slice(0, 8) + "...",
      direction: pressure.netDirection,
      score: pressure.pressureScore,
      buys: pressure.buyTxCount,
      sells: pressure.sellTxCount,
    }, "MEMPOOL PRESSURE FOUND");

    return opp;
  }
}
