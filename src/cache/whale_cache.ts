import { CacheManager } from "./cache_manager";
import { logger } from "../utils/logger";

export interface WhaleState {
  wallet: string;
  action: "accumulating" | "distributing" | "holding" | "unknown";
  token: string;
  amount: number;
  confidence: number;   // 0 to 1
  updatedAt: number;
}

// ASI06 — Memory/Context Poisoning defense. Redis is the agent's "memory"; a
// poisoned or malformed entry would silently steer decisions. We validate on
// READ (not just trust TTL): structure, value ranges, and staleness. A future
// `updatedAt` or out-of-range confidence is treated as tampered and dropped.
const MAX_AGE_MS = 15 * 60 * 1000; // hard staleness ceiling (TTL is 10m)

function isValidWhaleState(v: unknown): v is WhaleState {
  if (!v || typeof v !== "object") return false;
  const w = v as Record<string, unknown>;
  if (typeof w["wallet"] !== "string") return false;
  if (!["accumulating", "distributing", "holding", "unknown"].includes(w["action"] as string)) return false;
  if (typeof w["token"] !== "string") return false;
  if (typeof w["amount"] !== "number" || !Number.isFinite(w["amount"])) return false;
  if (typeof w["confidence"] !== "number" || w["confidence"] < 0 || w["confidence"] > 1) return false;
  if (typeof w["updatedAt"] !== "number") return false;
  const age = Date.now() - (w["updatedAt"] as number);
  if (age < -60_000 || age > MAX_AGE_MS) return false; // future-dated or too stale
  return true;
}

function parseValidated(raw: string | null): WhaleState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!isValidWhaleState(parsed)) {
      logger.warn({ raw: raw.slice(0, 120) }, "WhaleCache: dropped invalid/poisoned entry (ASI06)");
      return null;
    }
    return parsed;
  } catch {
    logger.warn("WhaleCache: dropped unparseable entry (ASI06)");
    return null;
  }
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
    return parseValidated(raw);
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
      .map((v) => parseValidated(v))
      .filter((w): w is WhaleState => w !== null);
  }
}