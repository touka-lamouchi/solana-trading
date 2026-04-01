import Redis from "ioredis";
import { logger } from "../utils/logger";

export class CacheManager {
  private redis: Redis;

  constructor(host: string = "localhost", port: number = 6379) {
    this.redis = new Redis({ host, port });

    this.redis.on("connect", () => {
      logger.info("Connected to Redis");
    });

    this.redis.on("error", (err) => {
      logger.error({ err }, "Redis connection error");
    });
  }

  getClient(): Redis {
    return this.redis;
  }

  async ping(): Promise<boolean> {
    const result = await this.redis.ping();
    return result === "PONG";
  }

  async disconnect(): Promise<void> {
    await this.redis.disconnect();
  }
}