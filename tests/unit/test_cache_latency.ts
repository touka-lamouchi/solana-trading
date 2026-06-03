import { CacheManager } from "../../src/cache/cache_manager";
import { SentimentCache } from "../../src/cache/sentiment_cache";
import { WhaleCache } from "../../src/cache/whale_cache";
import { RegimeCache } from "../../src/cache/regime_cache";
import { TokenScoreCache } from "../../src/cache/token_score_cache";
import { logger } from "../../src/utils/logger";
import fs from "fs";

async function testLatency() {
  const cache = new CacheManager();
  const sentiment = new SentimentCache(cache);
  const whale = new WhaleCache(cache);
  const regime = new RegimeCache(cache);
  const tokenScore = new TokenScoreCache(cache);

  const tokens = JSON.parse(fs.readFileSync("config/devnet_tokens.json", "utf-8"));

  logger.info("=== Testing cache read latency ===");

  const iterations = 100;

  // Sentiment read
  let start = performance.now();
  for (let i = 0; i < iterations; i++) {
    await sentiment.get(tokens.tokenA.mint);
  }
  let elapsed = performance.now() - start;
  logger.info({ avgMs: (elapsed / iterations).toFixed(3) }, "Sentiment cache avg read");

  // Whale read
  start = performance.now();
  for (let i = 0; i < iterations; i++) {
    await whale.get("whale_wallet_001");
  }
  elapsed = performance.now() - start;
  logger.info({ avgMs: (elapsed / iterations).toFixed(3) }, "Whale cache avg read");

  // Regime read
  start = performance.now();
  for (let i = 0; i < iterations; i++) {
    await regime.get(tokens.tokenB.mint, "5m");
  }
  elapsed = performance.now() - start;
  logger.info({ avgMs: (elapsed / iterations).toFixed(3) }, "Regime cache avg read");

  // Token score read
  start = performance.now();
  for (let i = 0; i < iterations; i++) {
    await tokenScore.get(tokens.tokenA.mint);
  }
  elapsed = performance.now() - start;
  logger.info({ avgMs: (elapsed / iterations).toFixed(3) }, "Token score cache avg read");

  logger.info("=== Target: all reads under 1ms ===");

  await cache.disconnect();
}

testLatency().catch(console.error);