import { TokenScoreCache, TokenSafetyScore } from "../../cache/token_score_cache";
import { logger } from "../../utils/logger";
import { getConfig } from "../../utils/config";

export interface S3Result {
  passed: boolean;
  token: string;
  anomalyScore: number;
  threshold: number;
  failReason?: string;
}

export class IsolationForest {
  private tokenScoreCache: TokenScoreCache;
  private threshold: number;

  constructor(tokenScoreCache: TokenScoreCache, threshold?: number) {
    this.tokenScoreCache = tokenScoreCache;
    this.threshold = threshold ?? getConfig().safety.isolation_forest_threshold;
  }

  async check(mintAddress: string): Promise<S3Result> {
    // In production, this calls the Python AI server which runs
    // a trained isolation forest model on the token's behavior data.
    // For now, we read from the token score cache which was populated
    // with pre-computed scores.

    try {
      const cached = await this.tokenScoreCache.get(mintAddress);

      if (!cached) {
        // No cached score — unknown token, treat as suspicious
        logger.warn({ token: mintAddress.slice(0, 8) + "..." }, "S3 FAILED — no cached score, unknown token");
        return {
          passed: false,
          token: mintAddress,
          anomalyScore: 1.0,
          threshold: this.threshold,
          failReason: "No anomaly score available — unknown token",
        };
      }

      const passed = cached.anomalyScore < this.threshold;

      if (passed) {
        logger.info({
          token: mintAddress.slice(0, 8) + "...",
          anomalyScore: cached.anomalyScore.toFixed(3),
        }, "S3 PASSED");
      } else {
        logger.warn({
          token: mintAddress.slice(0, 8) + "...",
          anomalyScore: cached.anomalyScore.toFixed(3),
          threshold: this.threshold,
        }, "S3 FAILED — anomalous behavior detected");
      }

      return {
        passed,
        token: mintAddress,
        anomalyScore: cached.anomalyScore,
        threshold: this.threshold,
        ...(!passed && { failReason: `Anomaly score ${cached.anomalyScore.toFixed(3)} exceeds threshold ${this.threshold}` }),
      };
    } catch (error) {
      logger.error({ token: mintAddress, error }, "S3 ERROR — treating as failed");
      return {
        passed: false,
        token: mintAddress,
        anomalyScore: 1.0,
        threshold: this.threshold,
        failReason: "Failed to check anomaly score",
      };
    }
  }
}