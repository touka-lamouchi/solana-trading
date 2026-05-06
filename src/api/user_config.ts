import { CacheManager } from "../cache/cache_manager";

export interface UserConfig {
  userId: string;
  dailyLimitUsd: number;
  maxTradeUsd: number;
  tradingHoursStart: string;
  tradingHoursEnd: string;
  enabledStrategies: string[];
  flashLoans: boolean;
  yieldGaps: boolean;
  liquidations: boolean;
  chartPatterns: boolean;
  socialBuzz: boolean;
  copyWhales: boolean;
  mode: "active" | "viewer";       // active = discover + execute, viewer = discover only (no trades)
  aiWeights: { chart: number; social: number; whale: number };
  aiConfidenceThreshold: number;
}

const DEFAULT_CONFIG: Omit<UserConfig, "userId"> = {
  dailyLimitUsd: 500,
  maxTradeUsd: 1000,
  tradingHoursStart: "00:00",
  tradingHoursEnd: "23:59",
  enabledStrategies: ["arbitrage", "flash_loan"],
  flashLoans: true,
  yieldGaps: true,
  liquidations: true,
  chartPatterns: true,
  socialBuzz: false,
  copyWhales: false,
  mode: "viewer",
  aiWeights: { chart: 45, social: 30, whale: 25 },
  aiConfidenceThreshold: 0.85,
};

export class UserConfigStore {
  private cache: CacheManager;
  private prefix = "userconfig:";

  constructor(cache: CacheManager) {
    this.cache = cache;
  }

  async get(userId: string): Promise<UserConfig> {
    const raw = await this.cache.getClient().get(this.prefix + userId);
    if (!raw) {
      return { userId, ...DEFAULT_CONFIG };
    }
    return JSON.parse(raw);
  }

  async set(userId: string, config: Partial<UserConfig>): Promise<UserConfig> {
    const existing = await this.get(userId);
    const merged = { ...existing, ...config, userId };
    await this.cache.getClient().set(
      this.prefix + userId,
      JSON.stringify(merged),
    );
    return merged;
  }

  async delete(userId: string): Promise<void> {
    await this.cache.getClient().del(this.prefix + userId);
  }

  async listUserIds(): Promise<string[]> {
    const keys = await this.cache.getClient().keys(this.prefix + "*");
    return keys.map((k) => k.replace(this.prefix, ""));
  }
}
