import { ModelServer, SentimentResult } from "../../models/model_server";
import { SentimentCache, SentimentScore } from "../../cache/sentiment_cache";
import { logger } from "../../utils/logger";

export interface SentimentSignalResult {
  token: string;
  score: number;       // -1 to +1
  label: string;       // positive | negative | neutral
  volume: number;
  mock: boolean;
}

export class SentimentSignal {
  private modelServer: ModelServer;
  private cache: SentimentCache;

  constructor(modelServer: ModelServer, cache: SentimentCache) {
    this.modelServer = modelServer;
    this.cache = cache;
  }

  async getSignal(tokenMint: string, tokenName?: string): Promise<SentimentSignalResult> {
    // 1. Check cache first (5min TTL)
    const cached = await this.cache.get(tokenMint);
    if (cached) {
      return {
        token: tokenMint,
        score: cached.score,
        label: cached.score > 0.05 ? "positive" : cached.score < -0.05 ? "negative" : "neutral",
        volume: cached.volume,
        mock: false,
      };
    }

    // 2. Call Python AI server
    const result = await this.modelServer.predictSentiment(tokenName || tokenMint).catch(() => null);

    if (!result) {
      return { token: tokenMint, score: 0, label: "neutral", volume: 0, mock: true };
    }

    // 3. Write to SentimentCache
    const cacheEntry: SentimentScore = {
      token: tokenMint,
      score: result.score,
      volume: result.volume,
      sources: ["reddit"],
      updatedAt: Date.now(),
    };
    await this.cache.set(tokenMint, cacheEntry).catch(() => {});

    logger.info({
      token: tokenMint.slice(0, 8) + "...",
      score: result.score,
      label: result.label,
      volume: result.volume,
      mock: result.mock,
    }, "Sentiment signal");

    return {
      token: tokenMint,
      score: result.score,
      label: result.label,
      volume: result.volume,
      mock: result.mock,
    };
  }
}
