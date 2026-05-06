import { CacheManager } from "../../cache/cache_manager";
import { logger } from "../../utils/logger";

export interface NewsSignalResult {
  cryptoScore: number;       // -1..+1
  cryptoMagnitude: number;   // 0..1
  geoScore: number;          // -1..+1
  geoMagnitude: number;      // 0..1
  combinedScore: number;     // -1..+1, weighted blend
  headlineCount: number;
  netDirection: "bullish" | "bearish" | "neutral" | "unknown";
  fresh: boolean;            // both windows updated within last 5min
}

interface CachedNews {
  score: number;
  magnitude: number;
  count: number;
  headlines: string[];
  updatedAt: number;
}

/**
 * NewsSignal — reads pre-scored news windows written by NewsFeedMonitor
 * and blends crypto + geopolitics into a single bullish/bearish read.
 *
 * Pure cache reader — never fetches RSS or calls the AI server itself.
 */
export class NewsSignal {
  private cache: CacheManager;
  private cryptoWeight: number;
  private geoWeight: number;

  constructor(cache: CacheManager, opts?: { cryptoWeight?: number; geoWeight?: number }) {
    this.cache = cache;
    this.cryptoWeight = opts?.cryptoWeight ?? 0.7;
    this.geoWeight = opts?.geoWeight ?? 0.3;
  }

  async getSignal(symbol: string): Promise<NewsSignalResult> {
    const sym = symbol.toLowerCase();
    const [cryptoRaw, geoRaw] = await Promise.all([
      this.cache.getClient().get(`news:crypto:${sym}`),
      this.cache.getClient().get("news:geopolitics:global"),
    ]);

    const crypto = this.parse(cryptoRaw);
    const geo = this.parse(geoRaw);

    const now = Date.now();
    const freshCutoff = 5 * 60 * 1000;
    const cryptoFresh = crypto && now - crypto.updatedAt < freshCutoff;
    const geoFresh = geo && now - geo.updatedAt < freshCutoff;

    // Magnitude-weighted blend: a strong crypto signal swamps weak geo and vice versa
    const cw = this.cryptoWeight * (crypto?.magnitude ?? 0);
    const gw = this.geoWeight * (geo?.magnitude ?? 0);
    const totalW = cw + gw;
    const combined = totalW > 0
      ? (cw * (crypto?.score ?? 0) + gw * (geo?.score ?? 0)) / totalW
      : 0;

    let netDirection: NewsSignalResult["netDirection"] = "unknown";
    if (!crypto && !geo) netDirection = "unknown";
    else if (combined > 0.15) netDirection = "bullish";
    else if (combined < -0.15) netDirection = "bearish";
    else netDirection = "neutral";

    const result: NewsSignalResult = {
      cryptoScore: crypto?.score ?? 0,
      cryptoMagnitude: crypto?.magnitude ?? 0,
      geoScore: geo?.score ?? 0,
      geoMagnitude: geo?.magnitude ?? 0,
      combinedScore: parseFloat(combined.toFixed(4)),
      headlineCount: (crypto?.count ?? 0) + (geo?.count ?? 0),
      netDirection,
      fresh: Boolean(cryptoFresh || geoFresh),
    };

    logger.info({
      symbol: sym,
      crypto: result.cryptoScore,
      geo: result.geoScore,
      combined: result.combinedScore,
      direction: result.netDirection,
      count: result.headlineCount,
    }, "News signal");

    return result;
  }

  private parse(raw: string | null): CachedNews | null {
    if (!raw) return null;
    try { return JSON.parse(raw) as CachedNews; } catch { return null; }
  }
}
