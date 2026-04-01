import { CacheManager } from "./cache_manager";

export interface SentimentScore {
  token: string;
  score: number;        // -1 (extreme fear) to +1 (extreme greed)
  volume: number;       // number of mentions
  sources: string[];    // which platforms contributed
  updatedAt: number;    // timestamp
}

export class SentimentCache {
  private cache: CacheManager;
  private prefix = "sentiment:";

  constructor(cache: CacheManager) {
    this.cache = cache;
  }

  async set(token: string, data: SentimentScore): Promise<void> {
    await this.cache.getClient().set(
      this.prefix + token,
      JSON.stringify(data),
      "EX",
      300 // expires in 5 minutes
    );
  }

  async get(token: string): Promise<SentimentScore | null> {
    const raw = await this.cache.getClient().get(this.prefix + token);
    if (!raw) return null;
    return JSON.parse(raw);
  }

  async getAll(): Promise<SentimentScore[]> {
    const keys = await this.cache.getClient().keys(this.prefix + "*");
    if (keys.length === 0) return [];
    const values = await this.cache.getClient().mget(keys);
    return values
      .filter((v): v is string => v !== null)
      .map((v) => JSON.parse(v));
  }
}