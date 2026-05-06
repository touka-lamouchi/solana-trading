import { CacheManager } from "../cache/cache_manager";
import { ModelServer, FeaturesResult } from "../models/model_server";
import { CandleFetcher, PoolState, Candle } from "./candle_fetcher";
import { PriceFeedRouter } from "./price_feeds/price_feed_router";
import { getConfig } from "../utils/config";
import { logger } from "../utils/logger";

interface FeatureColumns {
  regime: string[];
  gru: string[];
  gruSeqLen: number;
}

export class IngestionService {
  private candleFetcher: CandleFetcher;
  private modelServer: ModelServer;
  private featureColumns: FeatureColumns | null = null;
  private previousStates = new Map<string, PoolState>();
  private priceFeedRouter: PriceFeedRouter | null = null;
  private mainnetMode = false;
  private mainnetMint = "";
  private mainnetTimeframe = "1h";

  constructor(cache: CacheManager, modelServer: ModelServer) {
    this.candleFetcher = new CandleFetcher(cache);
    this.modelServer = modelServer;

    const cfg = getConfig();
    if (cfg.ai?.data_source === "mainnet") {
      this.mainnetMode = true;
      this.mainnetMint = cfg.ai?.target_mint_mainnet ?? "So11111111111111111111111111111111111111112";
      this.mainnetTimeframe = cfg.ai?.backfill_interval ?? "1h";
      this.priceFeedRouter = new PriceFeedRouter();
      logger.info({ mint: this.mainnetMint, timeframe: this.mainnetTimeframe },
        "IngestionService: mainnet data mode enabled (Binance + Pyth)");
    }
  }

  // Call once after engine construction to load feature column names from AI server.
  async init(): Promise<void> {
    try {
      const features: FeaturesResult | null = await this.modelServer.getFeatures();
      if (features && (features.regime_features.length > 0 || features.gru_features.length > 0)) {
        this.featureColumns = {
          regime: features.regime_features,
          gru: features.gru_features,
          gruSeqLen: features.gru_sequence_length,
        };
        logger.info({
          regimeFeatures: features.regime_features.length,
          gruFeatures: features.gru_features.length,
          gruSeqLen: features.gru_sequence_length,
        }, "Ingestion: feature columns loaded from AI server");
      } else {
        logger.warn("Ingestion: AI server returned no feature columns — predictions will use mock mode until server is running");
      }
    } catch (e: any) {
      logger.warn({ error: e.message }, "Ingestion: could not reach AI server for feature columns — mock mode");
    }

    if (this.mainnetMode && this.priceFeedRouter) {
      const cfg = getConfig();
      const backfillLimit = cfg.ai?.backfill_candles ?? 24;
      const candles = await this.priceFeedRouter.backfill(backfillLimit);
      await this.replaceMainnetCandles(candles);
    }
  }

  // Called each tick after pool states are fetched.
  // poolStates: map of poolKey → {reserveA, reserveB}
  // mintForPool: function that maps a poolKey to the token mint we want to track
  async ingestPoolStates(
    poolStates: Map<string, PoolState>,
    mintForPool: (poolKey: string) => string,
    timeframe = "15m",
  ): Promise<void> {
    if (this.mainnetMode && this.priceFeedRouter) {
      const candles = await this.priceFeedRouter.tick();
      if (candles.length > 0) await this.replaceMainnetCandles(candles);
      return;
    }

    for (const [key, state] of poolStates) {
      if (state.reserveB <= 0) continue;
      const mint = mintForPool(key);
      if (!mint) continue;

      const prev = this.previousStates.get(key) ?? null;
      const candle = this.candleFetcher.buildCandle(state, prev);
      if (candle) {
        await this.candleFetcher.appendCandle(mint, timeframe, candle).catch(() => {});
      }
      this.previousStates.set(key, { reserveA: state.reserveA, reserveB: state.reserveB });
    }
  }

  // Writes the full candle array returned by the router straight into Redis,
  // bypassing buildCandle (real OHLCV, not synthetic pool-ratio).
  private async replaceMainnetCandles(candles: Candle[]): Promise<void> {
    const redis = (this.candleFetcher as any).redis;
    if (!redis || candles.length === 0) return;
    const key = `candle:${this.mainnetMint}:${this.mainnetTimeframe}`;
    await redis.set(key, JSON.stringify(candles), "EX", 3600).catch(() => {});
  }

  // Returns feature vector for regime model (flat array matching regime_features order).
  async getRegimeFeatures(mint: string, timeframe = "15m"): Promise<number[]> {
    if (!this.featureColumns || this.featureColumns.regime.length === 0) return [];
    const tf = this.mainnetMode && mint === this.mainnetMint ? this.mainnetTimeframe : timeframe;
    const candles = await this.candleFetcher.getCandles(mint, tf);
    return this.candleFetcher.computeRegimeFeatures(candles, this.featureColumns.regime);
  }

  // Returns feature vector for GRU model (flat [seqLen * n_features] array).
  async getGRUFeatures(mint: string, timeframe = "15m"): Promise<number[]> {
    if (!this.featureColumns || this.featureColumns.gru.length === 0) return [];
    const tf = this.mainnetMode && mint === this.mainnetMint ? this.mainnetTimeframe : timeframe;
    const candles = await this.candleFetcher.getCandles(mint, tf);
    return this.candleFetcher.computeGRUFeatures(
      candles, this.featureColumns.gru, this.featureColumns.gruSeqLen,
    );
  }

  hasFeatureColumns(): boolean {
    return this.featureColumns !== null && this.featureColumns.regime.length > 0;
  }

  isMainnetMode(): boolean {
    return this.mainnetMode;
  }

  getMainnetMint(): string {
    return this.mainnetMint;
  }
}
