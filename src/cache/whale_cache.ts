import { CacheManager } from "./cache_manager";

export interface WhaleState {
  wallet: string;
  action: "accumulating" | "distributing" | "holding" | "unknown";
  token: string;
  amount: number;
  confidence: number;   // 0 to 1
  updatedAt: number;
}

export class WhaleCache {
  private cache: CacheManager;
  private prefix = "whale:";

  constructor(cache: CacheManager) {
    this.cache = cache;
  }

  async set(wallet: string, data: WhaleState): Promise<void> {
    await this.cache.getClient().set(
      this.prefix + wallet,
      JSON.stringify(data),
      "EX",
      600 // expires in 10 minutes
    );
  }

  async get(wallet: string): Promise<WhaleState | null> {
    const raw = await this.cache.getClient().get(this.prefix + wallet);
    if (!raw) return null;
    return JSON.parse(raw);
  }

  async getByToken(token: string): Promise<WhaleState[]> {
    const all = await this.getAll();
    return all.filter((w) => w.token === token);
  }

  async getAll(): Promise<WhaleState[]> {
    const keys = await this.cache.getClient().keys(this.prefix + "*");
    if (keys.length === 0) return [];
    const values = await this.cache.getClient().mget(keys);
    return values
      .filter((v): v is string => v !== null)
      .map((v) => JSON.parse(v));
  }
}