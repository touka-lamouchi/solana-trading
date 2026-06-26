import { CacheManager } from "./cache_manager";

export interface RegimePrediction {
  token: string;
  predictedDirection: "up" | "down" | "neutral";
  predictedChange: number;  // percentage
  confidence: number;       // 0 to 1
  timeframe: string;        // "5m", "15m", "1h"
  updatedAt: number;
}

export class RegimeCache {
  private cache: CacheManager;
  // Redis key prefix kept as "lstm:" for backward compatibility with already
  // cached entries; the class name is the source of truth, the key string is
  // just an internal identifier.
  private prefix = "lstm:";

  constructor(cache: CacheManager) {
    this.cache = cache;
  }

  async set(token: string, timeframe: string, data: RegimePrediction): Promise<void> {
    await this.cache.getClient().set(
      this.prefix + token + ":" + timeframe,
      JSON.stringify(data),
      "EX",
      120 // expires in 2 minutes
    );
  }

  async get(token: string, timeframe: string): Promise<RegimePrediction | null> {
    const raw = await this.cache.getClient().get(this.prefix + token + ":" + timeframe);
    if (!raw) return null;
    return JSON.parse(raw);
  }

  async getAll(): Promise<RegimePrediction[]> {
    const keys = await this.cache.getClient().keys(this.prefix + "*");
    if (keys.length === 0) return [];
    const values = await this.cache.getClient().mget(keys);
    return values
      .filter((v): v is string => v !== null)
      .map((v) => JSON.parse(v));
  }
}
