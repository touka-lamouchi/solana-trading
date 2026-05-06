import { ArbOpportunity, PoolState } from "../pure_code/arbitrage_detector";
import { SentimentSignal } from "./sentiment_signal";
import { logger } from "../../utils/logger";

export interface SocialBuzzConfig {
  scoreThreshold?: number;   // |sentiment.score| must exceed this (default 0.7)
  minVolume?: number;        // minimum number of posts (default 5)
}

/**
 * SocialBuzzDetector — predictive AI-driven detector backed by SentimentSignal.
 *
 * Reads the sentiment for the primary tracked token from Reddit (Gemini /
 * VADER under the hood). Emits a "social_buzz" opportunity when:
 *
 *   |sentiment.score| > scoreThreshold   (strong directional sentiment)
 *   sentiment.volume  >= minVolume       (enough posts to be statistically meaningful)
 *
 * Direction:
 *   positive score → bullish → tokenIn  = fUSDC, tokenOut = primary token
 *   negative score → bearish → tokenIn  = primary token, tokenOut = fUSDC
 *
 * Does NOT instantiate a new SentimentSignal — receives the engine's
 * existing instance, so the model server is hit once per tick across
 * all consumers (DecisionModel + this detector share the cache).
 */
export class SocialBuzzDetector {
  private sentimentSignal: SentimentSignal;
  private scoreThreshold: number;
  private minVolume: number;

  constructor(sentimentSignal: SentimentSignal, config: SocialBuzzConfig = {}) {
    this.sentimentSignal = sentimentSignal;
    this.scoreThreshold = config.scoreThreshold ?? 0.7;
    this.minVolume = config.minVolume ?? 5;
  }

  async scan(opts: {
    tokenMint: string;
    tokenName: string;
    capital: number;
    pool: PoolState | null;
    baseTokenName?: string;
    primaryTokenName?: string;
  }): Promise<ArbOpportunity | null> {
    if (!opts.pool) return null;

    const baseTokenName = opts.baseTokenName ?? "fUSDC";
    const primaryTokenName = opts.primaryTokenName ?? opts.tokenName;

    const sentiment = await this.sentimentSignal
      .getSignal(opts.tokenMint, opts.tokenName)
      .catch(() => null);

    if (!sentiment) return null;
    if (Math.abs(sentiment.score) <= this.scoreThreshold) return null;
    if (sentiment.volume < this.minVolume) return null;

    const isBullish = sentiment.score > 0;
    const tokenIn  = isBullish ? baseTokenName    : primaryTokenName;
    const tokenOut = isBullish ? primaryTokenName : baseTokenName;

    // Profit proxy: |score| × small magnitude (sentiment is directional, not
    // size-predictive). Slow path will refine via expectedOut at exec time.
    const expectedProfit = opts.capital * Math.abs(sentiment.score) * 0.02;
    const profitPercent = Math.abs(sentiment.score) * 2.0;

    const opp: ArbOpportunity = {
      type: "social_buzz",
      path: `social_buzz: ${sentiment.label} (score ${sentiment.score.toFixed(2)}, ${sentiment.volume} posts) → ${isBullish ? "bullish" : "bearish"} ${primaryTokenName}`,
      tokenIn,
      tokenOut,
      amountIn: opts.capital,
      expectedProfit,
      profitPercent: parseFloat(profitPercent.toFixed(2)),
      pools: [opts.pool],
      timestamp: Date.now(),
      signalSource: "social_buzz_detector",
    };

    logger.info({
      mint: opts.tokenMint.slice(0, 8) + "...",
      score: sentiment.score,
      label: sentiment.label,
      volume: sentiment.volume,
      direction: isBullish ? "bullish" : "bearish",
    }, "SOCIAL BUZZ FOUND");

    return opp;
  }
}
