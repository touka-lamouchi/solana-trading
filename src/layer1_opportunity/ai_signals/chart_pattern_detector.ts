import { ArbOpportunity, PoolState } from "../pure_code/arbitrage_detector";
import { DecisionResult } from "../decision_model";
import { logger } from "../../utils/logger";

export interface ChartPatternConfig {
  aiScoreThreshold?: number;        // min aiScore to fire (default 0.5)
  requiredRegime?: string;          // default "trending"
  requiredVolLevel?: "low" | "medium" | "high";  // default "high"
}

/**
 * ChartPatternDetector — predictive AI-driven detector.
 *
 * Reads the LAST DecisionModel output (regime + volLevel + direction +
 * aiScore) and produces a `chart_pattern` opportunity when:
 *
 *   regime === "trending"   (market is in a clear uptrend or downtrend)
 *   volLevel === "high"     (a vol spike is expected → breakout pattern)
 *   aiScore >= threshold    (other signals confirm)
 *
 * Direction is taken from the latest LSTM/regime direction:
 *   "bullish" → tokenIn = fUSDC, tokenOut = primary mint (buy)
 *   "bearish" → tokenIn = fSOL,  tokenOut = fUSDC (sell)
 *   "neutral" → no opportunity emitted
 */
export class ChartPatternDetector {
  private threshold: number;
  private requiredRegime: string;
  private requiredVolLevel: "low" | "medium" | "high";

  constructor(config: ChartPatternConfig = {}) {
    this.threshold = config.aiScoreThreshold ?? 0.5;
    this.requiredRegime = config.requiredRegime ?? "trending";
    this.requiredVolLevel = config.requiredVolLevel ?? "high";
  }

  /**
   * Build a chart_pattern opportunity, or null if conditions not met.
   *
   * @param decision   The latest DecisionResult from DecisionModel
   * @param primaryMint The non-base mint to trade against (e.g. fSOL)
   * @param capital    Capital to deploy
   * @param pool       The pool state to route the trade through
   */
  scan(
    decision: DecisionResult | null,
    primaryMint: string,
    capital: number,
    pool: PoolState | null,
    baseTokenName = "fUSDC",
    primaryTokenName = "fSOL",
  ): ArbOpportunity | null {
    if (!decision) {
      return null;
    }
    if (decision.regime !== this.requiredRegime) {
      return null;
    }
    if (decision.volLevel !== this.requiredVolLevel) {
      return null;
    }
    if (decision.aiScore < this.threshold) {
      return null;
    }
    if (decision.direction === "neutral") {
      return null;
    }
    if (!pool) {
      return null;
    }

    const isBullish = decision.direction === "bullish";
    const tokenIn  = isBullish ? baseTokenName    : primaryTokenName;
    const tokenOut = isBullish ? primaryTokenName : baseTokenName;

    // Expected profit proxy: vol expansion × directional bias.
    // We don't predict the move size directly; use volExpansionProb as a
    // magnitude hint scaled to a few percent of capital.
    const volMagnitude = decision.volExpansionProb ?? 0.5;
    const expectedProfit = capital * volMagnitude * 0.04;
    const profitPercent = volMagnitude * 4.0;

    const opp: ArbOpportunity = {
      type: "chart_pattern",
      path: `chart_pattern: ${this.requiredRegime}+${this.requiredVolLevel}vol → ${decision.direction} (aiScore ${decision.aiScore.toFixed(2)})`,
      tokenIn,
      tokenOut,
      amountIn: capital,
      expectedProfit,
      profitPercent: parseFloat(profitPercent.toFixed(2)),
      pools: [pool],
      timestamp: Date.now(),
      signalSource: "chart_pattern_detector",
    };

    logger.info({
      mint: primaryMint.slice(0, 8) + "...",
      direction: decision.direction,
      regime: decision.regime,
      volLevel: decision.volLevel,
      aiScore: decision.aiScore,
    }, "CHART PATTERN FOUND");

    return opp;
  }
}
