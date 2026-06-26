import { RegimeSignal, RegimeSignalResult } from "./ai_signals/regime_signal";
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

// ── Signal abstraction (Strategy pattern) ──────────────────────────────
//
// Each weighted AI sensor implements `Signal`. computeScore() iterates the
// signal list generically: it gathers every signal in parallel, maps each to a
// [0,1] score, weights them, and cross-validates them for the ASI01 agreement
// gate. Adding a sensor is one entry in the array — no edits to the weighting,
// agreement, or breakdown logic.
//
// Why VolatilityPredictor is NOT a Signal: it does not contribute a weighted
// term to the aiScore. It feeds volExpansionProb / volLevel, which act as a
// sizing/risk modifier downstream. It is therefore evaluated separately, not
// through this interface.

/** Stable key identifying which weight + breakdown slot a signal owns. */
export type SignalKey = "chart" | "social" | "whale" | "mempool" | "news";

/** Context passed to every signal each tick. */
export interface SignalContext {
  tokenMint: string;
  tokenName?: string;
  newsSymbol: string;
  featureHints?: { regimeFeatures: number[]; gruFeatures: number[] };
}

/** Per-signal output: a [0,1] score, whether it actually had data, and any
 *  metadata the DecisionResult surfaces for this sensor. */
export interface SignalOutput {
  /** Normalized score in [0,1] around a 0.5 neutral. */
  score: number;
  /** True when the sensor returned real data (counted in the agreement set). */
  present: boolean;
  /** Sensor-specific fields merged into the DecisionResult. */
  meta?: Partial<DecisionResult>;
}

export interface Signal {
  readonly key: SignalKey;
  /** Default weight share (0-100 scale, matching AIWeights). */
  readonly defaultWeight: number;
  evaluate(ctx: SignalContext): Promise<SignalOutput>;
}

// ── Concrete signal adapters ───────────────────────────────────────────

class ChartSignal implements Signal {
  readonly key = "chart" as const;
  readonly defaultWeight = 0; // chart/social/whale share the remainder; see weighting
  constructor(private readonly regime: RegimeSignal) {}
  async evaluate(ctx: SignalContext): Promise<SignalOutput> {
    const r = await this.regime
      .getSignal(ctx.tokenMint, "15m", ctx.featureHints?.regimeFeatures, ctx.featureHints?.gruFeatures)
      .catch((): RegimeSignalResult | null => null);
    if (!r) return { score: 0.5, present: false, meta: { regime: "unknown" } };
    const base = r.direction === "up" ? 0.7 : r.direction === "down" ? 0.3 : 0.5;
    // Scale by confidence: move further from 0.5 with higher confidence.
    const score = 0.5 + (base - 0.5) * r.confidence;
    return { score, present: true, meta: { regime: r.regime } };
  }
}

class SocialSignal implements Signal {
  readonly key = "social" as const;
  readonly defaultWeight = 0;
  constructor(private readonly sentiment: SentimentSignal) {}
  async evaluate(ctx: SignalContext): Promise<SignalOutput> {
    const r = await this.sentiment
      .getSignal(ctx.tokenMint, ctx.tokenName)
      .catch((): SentimentSignalResult | null => null);
    if (!r) return { score: 0.5, present: false, meta: { sentimentLabel: "neutral" } };
    return { score: (r.score + 1) / 2, present: true, meta: { sentimentLabel: r.label } };
  }
}

class WhaleSensorSignal implements Signal {
  readonly key = "whale" as const;
  readonly defaultWeight = 0;
  constructor(private readonly whale: WhaleSignal) {}
  async evaluate(ctx: SignalContext): Promise<SignalOutput> {
    const r = await this.whale.getSignal(ctx.tokenMint).catch((): WhaleSignalResult | null => null);
    if (!r || r.netDirection === "unknown") {
      return { score: 0.5, present: false, meta: { whaleDirection: r?.netDirection ?? "unknown" } };
    }
    const score =
      r.netDirection === "bullish" ? 0.5 + 0.5 * r.avgConfidence
      : r.netDirection === "bearish" ? 0.5 - 0.5 * r.avgConfidence
      : 0.5;
    return { score, present: true, meta: { whaleDirection: r.netDirection } };
  }
}

class MempoolSensorSignal implements Signal {
  readonly key = "mempool" as const;
  readonly defaultWeight = 15; // default 0.15 share
  constructor(private readonly mempool: MempoolSignal) {}
  async evaluate(ctx: SignalContext): Promise<SignalOutput> {
    const r = await this.mempool.getSignal(ctx.tokenMint).catch((): MempoolSignalResult | null => null);
    if (!r) return { score: 0.5, present: false };
    // pressureScore in [-1,+1] → [0,1]
    return {
      score: (r.pressureScore + 1) / 2,
      present: true,
      meta: { mempoolDirection: r.netDirection, mempoolPressure: parseFloat(r.pressureScore.toFixed(4)) },
    };
  }
}

class NewsSensorSignal implements Signal {
  readonly key = "news" as const;
  readonly defaultWeight = 10; // default 0.10 share
  constructor(private readonly news: NewsSignal) {}
  async evaluate(ctx: SignalContext): Promise<SignalOutput> {
    const r = await this.news.getSignal(ctx.newsSymbol).catch((): NewsSignalResult | null => null);
    if (!r) return { score: 0.5, present: false };
    // combinedScore in [-1,+1] → [0,1]
    return {
      score: (r.combinedScore + 1) / 2,
      present: true,
      meta: {
        newsDirection: r.netDirection,
        newsCombined: parseFloat(r.combinedScore.toFixed(4)),
        newsHeadlineCount: r.headlineCount,
      },
    };
  }
}

export class DecisionModel {
  // Five weighted sensors, iterated generically.
  private readonly signals: Signal[];
  // Volatility is a sizing modifier, not a weighted term — kept separate.
  private volatilityPredictor: VolatilityPredictor | null;
  private newsSymbol: string;

  constructor(
    regimeSignal: RegimeSignal,
    sentimentSignal: SentimentSignal,
    whaleSignal: WhaleSignal,
    volatilityPredictor: VolatilityPredictor | null = null,
    mempoolSignal: MempoolSignal | null = null,
    newsSignal: NewsSignal | null = null,
    newsSymbol: string = "sol",
  ) {
    // chart/social/whale are always present; mempool/news only when wired.
    this.signals = [
      new ChartSignal(regimeSignal),
      new SocialSignal(sentimentSignal),
      new WhaleSensorSignal(whaleSignal),
    ];
    if (mempoolSignal) this.signals.push(new MempoolSensorSignal(mempoolSignal));
    if (newsSignal) this.signals.push(new NewsSensorSignal(newsSignal));

    this.volatilityPredictor = volatilityPredictor;
    this.newsSymbol = newsSymbol;
  }

  async computeScore(
    tokenMint: string,
    weights: AIWeights,
    tokenName?: string,
    featureHints?: { regimeFeatures: number[]; gruFeatures: number[] },
  ): Promise<DecisionResult> {
    const ctx: SignalContext = {
      tokenMint,
      ...(tokenName !== undefined ? { tokenName } : {}),
      newsSymbol: this.newsSymbol,
      ...(featureHints ? { featureHints } : {}),
    };

    // 1. Gather every weighted signal in parallel + the volatility modifier.
    const [outputs, vol] = await Promise.all([
      Promise.all(this.signals.map((s) => s.evaluate(ctx))),
      this.volatilityPredictor && featureHints?.gruFeatures
        ? this.volatilityPredictor.predict(tokenMint, featureHints.gruFeatures).catch((): VolatilityResult | null => null)
        : Promise.resolve<VolatilityResult | null>(null),
    ]);

    // 2. Index scores by signal key for weighting + breakdown.
    const scoreByKey = new Map<SignalKey, number>();
    const presentByKey = new Map<SignalKey, boolean>();
    let mergedMeta: Partial<DecisionResult> = {};
    this.signals.forEach((s, i) => {
      const out = outputs[i]!;
      scoreByKey.set(s.key, out.score);
      presentByKey.set(s.key, out.present);
      if (out.meta) mergedMeta = { ...mergedMeta, ...out.meta };
    });

    const scoreOf = (k: SignalKey): number => scoreByKey.get(k) ?? 0.5;
    const chartScore = scoreOf("chart");
    const socialScore = scoreOf("social");
    const whaleScore = scoreOf("whale");
    const mempoolScore = scoreOf("mempool");
    const newsScore = scoreOf("news");

    // 3. Compose normalized weights. mempool (5th) and news (6th) carry a default
    //    fixed share when the user doesn't specify them; chart/social/whale share
    //    the remainder proportionally. Any explicit weight overrides the default.
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

    // 4. Weighted score.
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
    //     mempool pressure or an injected sentiment spike). Only sensors that
    //     actually returned data are counted so a missing sensor doesn't fake
    //     agreement.
    const presentScores: number[] = [];
    for (const s of this.signals) {
      if (presentByKey.get(s.key)) presentScores.push(scoreOf(s.key));
    }

    const { agreement, reason: disagreementReason } = computeSignalAgreement(presentScores);
    const reliable = presentScores.length >= 2 ? agreement >= AGREEMENT_FLOOR : true;

    // 5. Overall direction.
    let direction: "bullish" | "bearish" | "neutral" = "neutral";
    if (aiScore > 0.6) direction = "bullish";
    else if (aiScore < 0.4) direction = "bearish";

    const result: DecisionResult = {
      aiScore: parseFloat(aiScore.toFixed(4)),
      direction,
      regime: mergedMeta.regime ?? "unknown",
      sentimentLabel: mergedMeta.sentimentLabel ?? "neutral",
      whaleDirection: mergedMeta.whaleDirection ?? "unknown",
      volExpansionProb: vol ? parseFloat(vol.expansionProb.toFixed(4)) : null,
      volLevel: vol?.level ?? null,
      mempoolDirection: mergedMeta.mempoolDirection ?? null,
      mempoolPressure: mergedMeta.mempoolPressure ?? null,
      newsDirection: mergedMeta.newsDirection ?? null,
      newsCombined: mergedMeta.newsCombined ?? null,
      newsHeadlineCount: mergedMeta.newsHeadlineCount ?? null,
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
}
