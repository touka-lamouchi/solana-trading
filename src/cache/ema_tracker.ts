import { CacheManager } from "./cache_manager";

export interface EMARecord {
  strategy: string;
  token: string;
  dex: string;
  timeOfDay: string;      // "morning", "afternoon", "night"
  successRate: number;     // 0 to 1
  totalTrades: number;
  alpha: number;           // EMA smoothing factor
  updatedAt: number;
}

export class EMATracker {
  private cache: CacheManager;
  private prefix: string;
  private alpha = 0.1;     // recent trades weighted 10x more

  constructor(cache: CacheManager, userId: string = "default") {
    this.cache = cache;
    this.prefix = `ema:${userId}:`;
  }

  private getKey(strategy: string, token: string, dex: string): string {
    return this.prefix + `${strategy}:${token}:${dex}`;
  }

  async recordTrade(
    strategy: string,
    token: string,
    dex: string,
    success: boolean
  ): Promise<void> {
    const key = this.getKey(strategy, token, dex);
    const existing = await this.get(strategy, token, dex);

    const hour = new Date().getHours();
    const timeOfDay = hour < 8 ? "night" : hour < 16 ? "morning" : "afternoon";

    if (!existing) {
      const record: EMARecord = {
        strategy,
        token,
        dex,
        timeOfDay,
        successRate: success ? 1 : 0,
        totalTrades: 1,
        alpha: this.alpha,
        updatedAt: Date.now(),
      };
      await this.cache.getClient().set(key, JSON.stringify(record));
      return;
    }

    // EMA formula: new_rate = alpha * current_result + (1 - alpha) * old_rate
    const currentResult = success ? 1 : 0;
    existing.successRate =
      this.alpha * currentResult + (1 - this.alpha) * existing.successRate;
    existing.totalTrades += 1;
    existing.timeOfDay = timeOfDay;
    existing.updatedAt = Date.now();

    await this.cache.getClient().set(key, JSON.stringify(existing));
  }

  async get(strategy: string, token: string, dex: string): Promise<EMARecord | null> {
    const raw = await this.cache.getClient().get(this.getKey(strategy, token, dex));
    if (!raw) return null;
    return JSON.parse(raw);
  }

  async getByStrategy(strategy: string): Promise<EMARecord[]> {
    const keys = await this.cache.getClient().keys(this.prefix + strategy + ":*");
    if (keys.length === 0) return [];
    const values = await this.cache.getClient().mget(keys);
    return values
      .filter((v): v is string => v !== null)
      .map((v) => JSON.parse(v));
  }
}