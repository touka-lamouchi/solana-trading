import { ModelServer, RegimeResult, DirectionResult } from "../../models/model_server";
import { RegimeCache, RegimePrediction } from "../../cache/regime_cache";
import { logger } from "../../utils/logger";

// RegimeSignal — queries the Python AI server's regime classifier (an sklearn
// model served at /predict/regime) plus the direction endpoint, and returns a
// combined regime + direction reading. (Formerly named LSTMSignal; the backing
// model is not an LSTM.)
export interface RegimeSignalResult {
  token: string;
  regime: string;          // trending | ranging | crash
  direction: string;       // up | down | neutral
  confidence: number;      // 0-1
  predictedChange: number;
  mock: boolean;
}

export class RegimeSignal {
  private modelServer: ModelServer;
  private cache: RegimeCache;

  constructor(modelServer: ModelServer, cache: RegimeCache) {
    this.modelServer = modelServer;
    this.cache = cache;
  }

  async getSignal(
    tokenMint: string,
    timeframe: string = "15m",
    regimeFeatures?: number[],
    gruFeatures?: number[],
  ): Promise<RegimeSignalResult> {
    // 1. Check cache first (2min TTL)
    const cached = await this.cache.get(tokenMint, timeframe);
    if (cached) {
      return {
        token: tokenMint,
        regime: "trending", // cache doesn't store regime, use default
        direction: cached.predictedDirection,
        confidence: cached.confidence,
        predictedChange: cached.predictedChange,
        mock: false,
      };
    }

    // 2. Call Python AI server for regime + direction in parallel, passing computed features
    const [regimeResult, directionResult] = await Promise.all([
      this.modelServer.predictRegime(tokenMint, regimeFeatures).catch(() => null),
      this.modelServer.predictDirection(tokenMint, gruFeatures ?? regimeFeatures).catch(() => null),
    ]);

    const regime = regimeResult?.regime ?? "trending";
    const direction = directionResult?.direction ?? "neutral";
    const confidence = directionResult?.confidence ?? 0.5;
    const predictedChange = directionResult?.predicted_change ?? 0;
    const mock = (regimeResult?.mock !== false) || (directionResult?.mock !== false);

    // 3. Write to cache
    const prediction: RegimePrediction = {
      token: tokenMint,
      predictedDirection: direction as "up" | "down" | "neutral",
      predictedChange,
      confidence,
      timeframe,
      updatedAt: Date.now(),
    };
    await this.cache.set(tokenMint, timeframe, prediction).catch(() => {});

    logger.info({
      token: tokenMint.slice(0, 8) + "...",
      regime,
      direction,
      confidence: confidence.toFixed(3),
      mock,
    }, "Regime signal");

    return { token: tokenMint, regime, direction, confidence, predictedChange, mock };
  }
}
