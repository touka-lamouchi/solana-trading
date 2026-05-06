import { ModelServer, VolExpansionResult } from "../models/model_server";
import { logger } from "../utils/logger";

export interface VolatilityResult {
  expansionProb: number;
  level: "low" | "medium" | "high";
  mock: boolean;
}

// Calls /predict/vol-expansion on the AI server. The model (GRU) returns the
// probability that the next candle window will see a volatility expansion.
// Higher prob → bigger expected move → tighter size cap / wider slippage tolerance.
export class VolatilityPredictor {
  private modelServer: ModelServer;

  constructor(modelServer: ModelServer) {
    this.modelServer = modelServer;
  }

  async predict(mint: string, gruFeatures: number[]): Promise<VolatilityResult | null> {
    if (!gruFeatures || gruFeatures.length === 0) return null;

    let res: VolExpansionResult | null = null;
    try {
      res = await this.modelServer.predictVolExpansion(mint, gruFeatures);
    } catch (e: any) {
      logger.warn({ error: e.message }, "VolatilityPredictor call failed");
      return null;
    }

    if (!res) return null;

    const p = res.expansion_prob;
    const level: VolatilityResult["level"] =
      p >= 0.7 ? "high" : p >= 0.4 ? "medium" : "low";

    return { expansionProb: p, level, mock: res.mock };
  }
}
