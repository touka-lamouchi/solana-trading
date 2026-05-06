import { BinanceFeed } from "./binance_feed";
import { PythFeed } from "./pyth_feed";
import { Candle } from "../candle_fetcher";
import { logger } from "../../utils/logger";

// Fetches real SOL candles: Binance for 1h history, Pyth for the current live tick.
// The last candle in the returned array is rolled forward each call using the latest Pyth price,
// keeping the high/low/volume honest for the partial hour.
export class PriceFeedRouter {
  private binance: BinanceFeed;
  private pyth: PythFeed;
  private backfilled: Candle[] = [];
  private currentCandle: Candle | null = null;
  private currentBucketStart = 0;

  constructor() {
    this.binance = new BinanceFeed();
    this.pyth = new PythFeed();
  }

  // Called once on startup to seed the ring buffer from Binance.
  async backfill(limit = 24): Promise<Candle[]> {
    const klines = await this.binance.fetchKlines(limit);
    if (klines.length === 0) {
      logger.warn("PriceFeedRouter: Binance backfill returned 0 candles");
      return [];
    }
    this.backfilled = klines.slice(0, -1); // all closed hours
    const last = klines[klines.length - 1]!;
    this.currentCandle = { ...last };
    this.currentBucketStart = last.timestamp;
    logger.info({ closedCandles: this.backfilled.length, liveBucket: new Date(last.timestamp).toISOString() },
      "PriceFeedRouter: backfilled from Binance");
    return this.allCandles();
  }

  // Called each tick. Fetches Pyth price, updates the current live candle,
  // and rolls forward a new hourly bucket when the hour changes.
  async tick(): Promise<Candle[]> {
    const px = await this.pyth.fetchSolUsd();
    if (!px) return this.allCandles();

    const now = Date.now();
    const hourMs = 3600 * 1000;
    const bucketStart = Math.floor(now / hourMs) * hourMs;

    if (!this.currentCandle || bucketStart > this.currentBucketStart) {
      // Hour rolled — close the previous candle into backfilled, start a new one.
      if (this.currentCandle) {
        this.backfilled.push(this.currentCandle);
        if (this.backfilled.length > 23) {
          this.backfilled.splice(0, this.backfilled.length - 23);
        }
      }
      this.currentCandle = {
        timestamp: bucketStart,
        open: px.price,
        high: px.price,
        low: px.price,
        close: px.price,
        volume: 0,
      };
      this.currentBucketStart = bucketStart;
    } else {
      this.currentCandle.close = px.price;
      if (px.price > this.currentCandle.high) this.currentCandle.high = px.price;
      if (px.price < this.currentCandle.low) this.currentCandle.low = px.price;
    }
    return this.allCandles();
  }

  private allCandles(): Candle[] {
    return this.currentCandle ? [...this.backfilled, this.currentCandle] : [...this.backfilled];
  }

  hasData(): boolean {
    return this.backfilled.length > 0 || this.currentCandle !== null;
  }
}
