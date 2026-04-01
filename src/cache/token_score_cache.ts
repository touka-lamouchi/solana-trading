import { CacheManager } from "./cache_manager";

export interface TokenSafetyScore {
  token: string;
  overallScore: number;      // 0 (dangerous) to 100 (safe)
  liquidityLocked: boolean;
  mintAuthorityRevoked: boolean;
  devWalletPercent: number;
  isHoneypot: boolean;
  anomalyScore: number;      // from isolation forest
  updatedAt: number;
}

export class TokenScoreCache {
  private cache: CacheManager;
  private prefix = "tokenscore:";

  constructor(cache: CacheManager) {
    this.cache = cache;
  }

  async set(token: string, data: TokenSafetyScore): Promise<void> {
    await this.cache.getClient().set(
      this.prefix + token,
      JSON.stringify(data),
      "EX",
      1800 // expires in 30 minutes
    );
  }

  async get(token: string): Promise<TokenSafetyScore | null> {
    const raw = await this.cache.getClient().get(this.prefix + token);
    if (!raw) return null;
    return JSON.parse(raw);
  }

  async isSafe(token: string, minScore: number = 70): Promise<boolean> {
    const score = await this.get(token);
    if (!score) return false;
    return score.overallScore >= minScore && !score.isHoneypot;
  }
}