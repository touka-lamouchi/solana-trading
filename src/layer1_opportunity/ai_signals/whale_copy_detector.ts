import { ArbOpportunity, PoolState } from "../pure_code/arbitrage_detector";
import { WhaleSignal } from "./whale_signal";
import { logger } from "../../utils/logger";

export interface WhaleCopyConfig {
  confidenceThreshold?: number;   // avgConfidence required (default 0.8)
}

/**
 * WhaleCopyDetector — predictive detector backed by WhaleSignal.
 *
 * Reads aggregated whale activity for the primary tracked token (from
 * Redis-cached on-chain balance deltas). Emits a "copy_whale" opportunity
 * when whales are showing strong directional conviction:
 *
 *   netDirection === "bullish"  AND avgConfidence > 0.8  → bullish (buy)
 *   netDirection === "bearish"  AND avgConfidence > 0.8  → bearish (sell)
 *
 * Direction:
 *   bullish → tokenIn = fUSDC, tokenOut = primary token
 *   bearish → tokenIn = primary token, tokenOut = fUSDC
 *
 * Does NOT instantiate a new WhaleSignal — receives the engine's existing
 * instance so the WhaleCache is shared across consumers (DecisionModel +
 * this detector + logWhaleSignals).
 */
export class WhaleCopyDetector {
  private whaleSignal: WhaleSignal;
  private confidenceThreshold: number;

  constructor(whaleSignal: WhaleSignal, config: WhaleCopyConfig = {}) {
    this.whaleSignal = whaleSignal;
    this.confidenceThreshold = config.confidenceThreshold ?? 0.8;
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

    const whale = await this.whaleSignal
      .getSignal(opts.tokenMint)
      .catch(() => null);

    if (!whale) return null;
    if (whale.netDirection !== "bullish" && whale.netDirection !== "bearish") return null;
    if (whale.avgConfidence <= this.confidenceThreshold) return null;

    const isBullish = whale.netDirection === "bullish";
    const tokenIn  = isBullish ? baseTokenName    : primaryTokenName;
    const tokenOut = isBullish ? primaryTokenName : baseTokenName;

    // Profit proxy: confidence × small magnitude. Whale signal is directional
    // conviction not size — actual return depends on follow-through.
    const expectedProfit = opts.capital * whale.avgConfidence * 0.025;
    const profitPercent = whale.avgConfidence * 2.5;

    const dominantCount = isBullish ? whale.accumulatingCount : whale.distributingCount;
    const oppositeCount = isBullish ? whale.distributingCount : whale.accumulatingCount;

    const opp: ArbOpportunity = {
      type: "copy_whale",
      path: `copy_whale: ${whale.netDirection} (${dominantCount}↑/${oppositeCount}↓ wallets, conf ${whale.avgConfidence.toFixed(2)}) → ${primaryTokenName}`,
      tokenIn,
      tokenOut,
      amountIn: opts.capital,
      expectedProfit,
      profitPercent: parseFloat(profitPercent.toFixed(2)),
      pools: [opts.pool],
      timestamp: Date.now(),
      signalSource: "whale_copy_detector",
    };

    logger.info({
      mint: opts.tokenMint.slice(0, 8) + "...",
      direction: whale.netDirection,
      confidence: whale.avgConfidence,
      accumulating: whale.accumulatingCount,
      distributing: whale.distributingCount,
    }, "COPY WHALE FOUND");

    return opp;
  }
}
