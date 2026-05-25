import { LSTMSignal, LSTMSignalResult } from "./ai_signals/lstm_signal";
import { SentimentSignal, SentimentSignalResult } from "./ai_signals/sentiment_signal";
import { WhaleSignal, WhaleSignalResult } from "./ai_signals/whale_signal";
import { MempoolSignal, MempoolSignalResult } from "./ai_signals/mempool_signal";
import { NewsSignal, NewsSignalResult } from "./ai_signals/news_signal";
import { VolatilityPredictor, VolatilityResult } from "../layer2_execution/volatility_predictor";
import { logger } from "../utils/logger";

export interface AIWeights {
  chart: number;    // 0-100
  social: number;   // 0-100
  whale: number;    // 0-100
  mempool?: number; // 0-100 (optional; default behavior splits ~15% off others)
  news?: number;    // 0-100 (optional; defaults to fixed 0.10 share)
}

export interface DecisionResult {
  aiScore: number;           // 0 to 1 (normalized weighted score)
  direction: "bullish" | "bearish" | "neutral";
  regime: string;
  sentimentLabel: string;
  whaleDirection: string;
  volExpansionProb: number | null;   // 0 to 1 — probability of vol spike
  volLevel: "low" | "medium" | "high" | null;
  mempoolDirection: "bullish" | "bearish" | "neutral" | "unknown" | null;
  mempoolPressure: number | null;
  newsDirection: "bullish" | "bearish" | "neutral" | "unknown" | null;
  newsCombined: number | null;
  newsHeadlineCount: number | null;
  breakdown: {
    chartScore: number;
    socialScore: number;
    whaleScore: number;
    mempoolScore: number;
    newsScore: number;
  };
  // ASI01 — Agent Goal Hijack defense: how much the independent sensors agree.
  // Low agreement means one or more sensors may be poisoned/manipulated, so the
  // aggregate score should be trusted less. signalAgreement in [0,1] (1 = all
  // sensors point the same way). reliable=false when agreement is below floor.
  signalAgreement: number;
  reliable: boolean;
  disagreementReason?: string;
}

// Exported pure agreement math (ASI01) — used by DecisionModel and backtests so
// both exercise the identical logic. Agreement = 1 - 2*stddev(scores), clamped
// to [0,1]; scores are each in [0,1] around a 0.5 neutral.
export function computeSignalAgreement(scores: number[]): { agreement: number; reason?: string } {
  if (scores.length < 2) return { agreement: 1 };
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const variance = scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length;
  const std = Math.sqrt(variance);
  const agreement = Math.max(0, Math.min(1, 1 - 2 * std));
  const bullish = scores.filter((s) => s > 0.6).length;
  const bearish = scores.filter((s) => s < 0.4).length;
  const reason = bullish > 0 && bearish > 0 ? `${bullish} bullish vs ${bearish} bearish sensors` : undefined;
  return { agreement, ...(reason ? { reason } : {}) };
}

/** Floor below which a multi-sensor decision is considered unreliable. */
export const AGREEMENT_FLOOR = 0.5;

export class DecisionModel {
  private lstmSignal: LSTMSignal;
  private sentimentSignal: SentimentSignal;
  private whaleSignal: WhaleSignal;
  private volatilityPredictor: VolatilityPredictor | null;
  private mempoolSignal: MempoolSignal | null;
  private newsSignal: NewsSignal | null;
  private newsSymbol: string;

  constructor(
    lstmSignal: LSTMSignal,
    sentimentSignal: SentimentSignal,
    whaleSignal: WhaleSignal,
    volatilityPredictor: VolatilityPredictor | null = null,
    mempoolSignal: MempoolSignal | null = null,
    newsSignal: NewsSignal | null = null,
    newsSymbol: string = "sol",
  ) {
    this.lstmSignal = lstmSignal;
    this.sentimentSignal = sentimentSignal;
    this.whaleSignal = whaleSignal;
    this.volatilityPredictor = volatilityPredictor;
    this.mempoolSignal = mempoolSignal;
    this.newsSignal = newsSignal;
    this.newsSymbol = newsSymbol;
  }

  async computeScore(
    tokenMint: string,
    weights: AIWeights,
    tokenName?: string,
    featureHints?: { regimeFeatures: number[]; gruFeatures: number[] },
  ): Promise<DecisionResult> {
    // 1. Gather all signals in parallel — including 5th (mempool) and 6th (news)
    const [lstm, sentiment, whale, vol, mempool, news] = await Promise.all([
      this.lstmSignal.getSignal(tokenMint, "15m", featureHints?.regimeFeatures, featureHints?.gruFeatures).catch((): LSTMSignalResult | null => null),
      this.sentimentSignal.getSignal(tokenMint, tokenName).catch((): SentimentSignalResult | null => null),
      this.whaleSignal.getSignal(tokenMint).catch((): WhaleSignalResult | null => null),
      this.volatilityPredictor && featureHints?.gruFeatures
        ? this.volatilityPredictor.predict(tokenMint, featureHints.gruFeatures).catch((): VolatilityResult | null => null)
        : Promise.resolve<VolatilityResult | null>(null),
      this.mempoolSignal
        ? this.mempoolSignal.getSignal(tokenMint).catch((): MempoolSignalResult | null => null)
        : Promise.resolve<MempoolSignalResult | null>(null),
      this.newsSignal
        ? this.newsSignal.getSignal(this.newsSymbol).catch((): NewsSignalResult | null => null)
        : Promise.resolve<NewsSignalResult | null>(null),
    ]);

    // 2. Convert each signal to a 0-1 score
    const chartScore = this.directionToScore(lstm);
    const socialScore = sentiment ? (sentiment.score + 1) / 2 : 0.5;
    const whaleScore = this.whaleToScore(whale);
    // mempool.pressureScore is in [-1,+1] → map to [0,1]
    const mempoolScore = mempool ? (mempool.pressureScore + 1) / 2 : 0.5;
    // news.combinedScore is in [-1,+1] → map to [0,1]; neutral if no signal
    const newsScore = news ? (news.combinedScore + 1) / 2 : 0.5;

    // 3. Compose weights — mempool (5th) and news (6th) each have a default
    //    fixed share when not specified by the user. Defaults: mempool 0.15,
    //    news 0.10. The other three (chart/social/whale) share the remainder
    //    proportionally. Any explicit weight overrides the default.
    const userMempool = weights.mempool;
    const userNews = weights.news;
    const otherSum = weights.chart + weights.social + weights.whale;

    let normChart: number, normSocial: number, normWhale: number;
    let normMempool: number, normNews: number;

    if ((userMempool != null && userMempool >= 0) || (userNews != null && userNews >= 0)) {
      // At least one extra weight specified → renormalize all six together,
      // using defaults for any extras the user omitted.
      const mp = userMempool != null && userMempool >= 0 ? userMempool : 15;
      const nw = userNews    != null && userNews    >= 0 ? userNews    : 10;
      const total = otherSum + mp + nw;
      if (total > 0) {
        normChart   = weights.chart  / total;
        normSocial  = weights.social / total;
        normWhale   = weights.whale  / total;
        normMempool = mp             / total;
        normNews    = nw             / total;
      } else {
        normChart = normSocial = normWhale = normMempool = normNews = 1 / 5;
      }
    } else {
      // Default: mempool 0.15, news 0.10, others share remaining 0.75 proportionally
      normMempool = 0.15;
      normNews    = 0.10;
      const remainder = 1 - normMempool - normNews;
      if (otherSum > 0) {
        normChart  = (weights.chart  / otherSum) * remainder;
        normSocial = (weights.social / otherSum) * remainder;
        normWhale  = (weights.whale  / otherSum) * remainder;
      } else {
        normChart = normSocial = normWhale = remainder / 3;
      }
    }

    // 4. Compute weighted score
    const aiScore =
      normChart   * chartScore +
      normSocial  * socialScore +
      normWhale   * whaleScore +
      normMempool * mempoolScore +
      normNews    * newsScore;

    // 4b. ASI01 — cross-validate the independent sensors. Each sub-score is in
    //     [0,1] around a 0.5 neutral. Standard deviation across the *present*
    //     sensors measures disagreement; a tightly clustered set is trustworthy,
    //     a wide spread suggests one sensor may be manipulated (e.g. spoofed
    //     mempool pressure or an injected sentiment spike). We only count sensors
    //     that actually returned data (non-0.5-default) so a missing sensor
    //     doesn't fake agreement.
    const presentScores: number[] = [];
    if (lstm) presentScores.push(chartScore);
    if (sentiment) presentScores.push(socialScore);
    if (whale && whale.netDirection !== "unknown") presentScores.push(whaleScore);
    if (mempool) presentScores.push(mempoolScore);
    if (news) presentScores.push(newsScore);

    const { agreement, reason: disagreementReason } = this.computeAgreement(presentScores);
    const reliable = presentScores.length >= 2 ? agreement >= AGREEMENT_FLOOR : true;

    // 5. Determine overall direction
    let direction: "bullish" | "bearish" | "neutral" = "neutral";
    if (aiScore > 0.6) direction = "bullish";
    else if (aiScore < 0.4) direction = "bearish";

    const result: DecisionResult = {
      aiScore: parseFloat(aiScore.toFixed(4)),
      direction,
      regime: lstm?.regime ?? "unknown",
      sentimentLabel: sentiment?.label ?? "neutral",
      whaleDirection: whale?.netDirection ?? "unknown",
      volExpansionProb: vol ? parseFloat(vol.expansionProb.toFixed(4)) : null,
      volLevel: vol?.level ?? null,
      mempoolDirection: mempool?.netDirection ?? null,
      mempoolPressure: mempool ? parseFloat(mempool.pressureScore.toFixed(4)) : null,
      newsDirection: news?.netDirection ?? null,
      newsCombined: news ? parseFloat(news.combinedScore.toFixed(4)) : null,
      newsHeadlineCount: news?.headlineCount ?? null,
      breakdown: {
        chartScore: parseFloat(chartScore.toFixed(4)),
        socialScore: parseFloat(socialScore.toFixed(4)),
        whaleScore: parseFloat(whaleScore.toFixed(4)),
        mempoolScore: parseFloat(mempoolScore.toFixed(4)),
        newsScore: parseFloat(newsScore.toFixed(4)),
      },
      signalAgreement: parseFloat(agreement.toFixed(4)),
      reliable,
      ...(disagreementReason ? { disagreementReason } : {}),
    };

    logger.info({
      token: tokenMint.slice(0, 8) + "...",
      aiScore: result.aiScore,
      direction: result.direction,
      regime: result.regime,
      volExp: result.volExpansionProb,
      volLvl: result.volLevel,
      mempool: result.mempoolPressure,
      news: result.newsCombined,
      newsCount: result.newsHeadlineCount,
      chart: chartScore.toFixed(2),
      social: socialScore.toFixed(2),
      whale: whaleScore.toFixed(2),
      mempoolS: mempoolScore.toFixed(2),
      newsS: newsScore.toFixed(2),
      agreement: result.signalAgreement,
      reliable: result.reliable,
    }, "AI Decision");

    if (!reliable) {
      logger.warn(
        { token: tokenMint.slice(0, 8) + "...", agreement: result.signalAgreement, reason: disagreementReason },
        "AI signals disagree (ASI01) — decision marked unreliable; execution should gate on this"
      );
    }

    return result;
  }

  private computeAgreement(scores: number[]): { agreement: number; reason?: string } {
    return computeSignalAgreement(scores);
  }

  private directionToScore(lstm: LSTMSignalResult | null): number {
    if (!lstm) return 0.5;
    const base = lstm.direction === "up" ? 0.7
               : lstm.direction === "down" ? 0.3
               : 0.5;
    // Scale by confidence: move further from 0.5 with higher confidence
    return 0.5 + (base - 0.5) * lstm.confidence;
  }

  private whaleToScore(whale: WhaleSignalResult | null): number {
    if (!whale || whale.netDirection === "unknown") return 0.5;
    if (whale.netDirection === "bullish") return 0.5 + 0.5 * whale.avgConfidence;
    if (whale.netDirection === "bearish") return 0.5 - 0.5 * whale.avgConfidence;
    return 0.5; // neutral
  }
}
