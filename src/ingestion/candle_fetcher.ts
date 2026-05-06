import { CacheManager } from "../cache/cache_manager";

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface PoolState {
  reserveA: number;
  reserveB: number;
}

const MAX_CANDLES = 24;
const CANDLE_TTL_SECS = 3600;

export class CandleFetcher {
  private redis: any;

  constructor(cache: CacheManager) {
    this.redis = (cache as any).client ?? (cache as any).redis ?? cache;
  }

  // Build a synthetic candle from on-chain pool reserve snapshots.
  // Price = reserveA / reserveB (tokenA per tokenB, e.g. fUSDC per fSOL).
  buildCandle(state: PoolState, prevState: PoolState | null): Candle | null {
    if (state.reserveB <= 0) return null;
    const close = state.reserveA / state.reserveB;
    const open = prevState && prevState.reserveB > 0
      ? prevState.reserveA / prevState.reserveB
      : close;
    return {
      timestamp: Date.now(),
      open,
      high: Math.max(open, close),
      low: Math.min(open, close),
      close,
      volume: Math.abs(state.reserveA - (prevState?.reserveA ?? state.reserveA)),
    };
  }

  private candleKey(mint: string, timeframe: string): string {
    return `candle:${mint}:${timeframe}`;
  }

  async appendCandle(mint: string, timeframe: string, candle: Candle): Promise<void> {
    const key = this.candleKey(mint, timeframe);
    const raw = await this.redis.get(key);
    const candles: Candle[] = raw ? JSON.parse(raw) : [];
    candles.push(candle);
    if (candles.length > MAX_CANDLES) candles.splice(0, candles.length - MAX_CANDLES);
    await this.redis.set(key, JSON.stringify(candles), "EX", CANDLE_TTL_SECS);
  }

  async getCandles(mint: string, timeframe: string): Promise<Candle[]> {
    const key = this.candleKey(mint, timeframe);
    const raw = await this.redis.get(key);
    return raw ? JSON.parse(raw) : [];
  }

  // ── Feature computation ──────────────────────────────────

  computeRegimeFeatures(candles: Candle[], featureNames: string[]): number[] {
    if (candles.length < 2) return [];
    const closes = candles.map(c => c.close);
    const volumes = candles.map(c => c.volume);
    const returns = closes.slice(1).map((c, i) => closes[i]! > 0 ? (c - closes[i]!) / closes[i]! : 0);

    return featureNames.map(name => this.computeFeature(name, closes, volumes, returns));
  }

  // Build a flat [seqLen * n_features] array for the GRU model.
  // Each row is the feature vector at that timestep (using candles up to that point).
  computeGRUFeatures(candles: Candle[], featureNames: string[], seqLen: number): number[] {
    if (candles.length < 2 || featureNames.length === 0) return [];
    const result: number[] = [];
    const startIdx = Math.max(0, candles.length - seqLen);
    for (let t = startIdx; t < candles.length; t++) {
      const slice = candles.slice(0, t + 1);
      const closes = slice.map(c => c.close);
      const volumes = slice.map(c => c.volume);
      const rets = closes.slice(1).map((c, i) => closes[i]! > 0 ? (c - closes[i]!) / closes[i]! : 0);
      for (const name of featureNames) {
        result.push(this.computeFeature(name, closes, volumes, rets));
      }
    }
    return result;
  }

  private computeFeature(name: string, closes: number[], volumes: number[], returns: number[]): number {
    const n = name.toLowerCase();

    // Helper: N-period price return (shared by price_change_N, return_N, roc_N, momentum_N)
    const priceReturn = (p: number): number => {
      const s = closes.slice(-(p + 1));
      const sLast = s[s.length - 1] ?? 0;
      const rLast = returns[returns.length - 1] ?? 0;
      return s.length >= 2 && s[0]! > 0 ? (sLast - s[0]!) / s[0]! : rLast;
    };

    // price_change_N / return_N / roc_N / momentum_N — all map to N-period price return
    const priceRetMatch = n.match(/(?:price_change|return|roc|momentum)[_]?(\d+)?/);
    if (priceRetMatch) {
      const p = parseInt(priceRetMatch[1] ?? "1");
      return priceReturn(p);
    }

    // volatility_N / vol_N / volatil — rolling std of returns over N periods
    if (n.match(/volatil|^vol_|^vol\b/)) {
      const p = parseInt(n.match(/(\d+)/)?.[1] ?? "5");
      return this.rollingStd(returns, p);
    }

    // rsi / rsi_N
    if (n.match(/rsi/)) {
      const p = parseInt(n.match(/(\d+)/)?.[1] ?? "14");
      return this.computeRSI(closes, p) / 100;
    }

    // volume_change_N — N-period volume change ratio
    if (n.match(/volume_change/)) {
      const p = parseInt(n.match(/(\d+)/)?.[1] ?? "24");
      const slice = volumes.slice(-(p + 1));
      const first = slice[0] ?? 0;
      const last = slice[slice.length - 1] ?? 0;
      return first > 0 ? (last - first) / first : 0;
    }

    // volume_buy_ratio — proxy: last vol / mean vol (we have no buy/sell split)
    if (n.match(/volume_buy_ratio/)) {
      const lastVol = volumes[volumes.length - 1] ?? 0;
      const mean = this.rollingMean(volumes, 10);
      return mean > 0 ? Math.min(lastVol / mean, 2.0) : 1.0;
    }

    // volume_ratio_N / vol_ratio — last vol / mean vol
    if (n.match(/volume_ratio|vol_ratio/)) {
      const p = parseInt(n.match(/(\d+)/)?.[1] ?? "10");
      const lastVol = volumes[volumes.length - 1] ?? 0;
      const mean = this.rollingMean(volumes, p);
      return mean > 0 ? lastVol / mean : 1;
    }

    // trades_change — proxy for trade count change: use volume change over 4 periods
    if (n.match(/trades_change/)) {
      return priceReturn(4);
    }

    // high_low_range_pct / hl_range — abs(return) as proxy for (high - low) / close
    if (n.match(/high_low_range_pct|hl_range/)) {
      return Math.abs(returns[returns.length - 1] ?? 0);
    }

    // above_ema_N — binary: 1 if close > rolling mean(N), else 0
    if (n.match(/above_ema/)) {
      const p = parseInt(n.match(/(\d+)/)?.[1] ?? "200");
      const ma = this.rollingMean(closes, Math.min(p, closes.length));
      const last = closes[closes.length - 1] ?? 0;
      return last > ma ? 1 : 0;
    }

    // dist_from_ema_N — (close - ema) / ema
    if (n.match(/dist_from_ema/)) {
      const p = parseInt(n.match(/(\d+)/)?.[1] ?? "200");
      const ma = this.rollingMean(closes, Math.min(p, closes.length));
      const last = closes[closes.length - 1] ?? 0;
      return ma > 0 ? (last - ma) / ma : 0;
    }

    // price_ma_N / price_vs_ma / ma_N
    if (n.match(/price_ma|price_vs_ma|ma_\d/)) {
      const p = parseInt(n.match(/(\d+)/)?.[1] ?? "5");
      const ma = this.rollingMean(closes, p);
      const closeLast = closes[closes.length - 1] ?? 0;
      return ma > 0 ? (closeLast / ma) - 1 : 0;
    }

    // close / volume raw values
    if (n === "close") return closes[closes.length - 1] ?? 0;
    if (n === "volume") return volumes[volumes.length - 1] ?? 0;

    return 0;
  }

  private rollingStd(arr: number[], n: number): number {
    const slice = arr.slice(-n);
    if (slice.length < 2) return 0;
    const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
    return Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / slice.length);
  }

  private rollingMean(arr: number[], n: number): number {
    const slice = arr.slice(-n);
    return slice.length ? slice.reduce((a, b) => a + b, 0) / slice.length : 0;
  }

  private computeRSI(closes: number[], period = 14): number {
    if (closes.length < period + 1) return 50;
    const gains: number[] = [];
    const losses: number[] = [];
    for (let i = 1; i < closes.length; i++) {
      const d = closes[i]! - closes[i - 1]!;
      gains.push(d > 0 ? d : 0);
      losses.push(d < 0 ? -d : 0);
    }
    const avgGain = gains.slice(-period).reduce((a, b) => a + b, 0) / period;
    const avgLoss = losses.slice(-period).reduce((a, b) => a + b, 0) / period;
    if (avgLoss === 0) return 100;
    return 100 - 100 / (1 + avgGain / avgLoss);
  }
}
