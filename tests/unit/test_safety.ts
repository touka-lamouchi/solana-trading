import { Connection } from "@solana/web3.js";
import { SafetyPipeline } from "../../src/layer1_opportunity/safety_filters/safety_pipeline";
import { CacheManager } from "../../src/cache/cache_manager";
import { logger } from "../../src/utils/logger";
import fs from "fs";

async function testSafety() {
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const cache = new CacheManager();

  // Wait for Redis connection
  await new Promise((r) => setTimeout(r, 500));

  const pipeline = new SafetyPipeline(connection, cache);

  const tokens = JSON.parse(fs.readFileSync("config/devnet_tokens.json", "utf-8"));
  const dirty = JSON.parse(fs.readFileSync("config/devnet_dirty_tokens.json", "utf-8"));
  const pools = JSON.parse(fs.readFileSync("config/devnet_pools.json", "utf-8"));

  // Test 1: Clean token (fUSDC) — should PASS
  logger.info("=== Test 1: Clean token (fUSDC) ===");
  const result1 = await pipeline.check(tokens.tokenA.mint, pools.pool1.address);
  logger.info({ passed: result1.passed, failedAt: result1.failedAt }, "fUSDC result");

  // Test 2: Dirty token 1 (mint + freeze authority active) — should FAIL at S1
  logger.info("=== Test 2: Dirty token (mint authority active) ===");
  const result2 = await pipeline.check(dirty.dirty1_mint_authority.mint);
  logger.info({ passed: result2.passed, failedAt: result2.failedAt }, "Dirty 1 result");

  // Test 3: Dirty token 2 (90% dev wallet) — should FAIL at S1
  logger.info("=== Test 3: Dirty token (90% dev wallet) ===");
  const result3 = await pipeline.check(dirty.dirty2_dev_heavy.mint);
  logger.info({ passed: result3.passed, failedAt: result3.failedAt }, "Dirty 2 result");

  // Test 4: Clean comparison token — should PASS or FAIL at S3 (no cached score)
  logger.info("=== Test 4: Clean comparison token ===");
  const result4 = await pipeline.check(dirty.clean.mint);
  logger.info({ passed: result4.passed, failedAt: result4.failedAt }, "Clean token result");

  // Summary
  logger.info("=== SAFETY FILTER SUMMARY ===");
  logger.info({
    fUSDC: result1.passed ? "PASS" : `FAIL at ${result1.failedAt}`,
    dirty1: result2.passed ? "PASS" : `FAIL at ${result2.failedAt}`,
    dirty2: result3.passed ? "PASS" : `FAIL at ${result3.failedAt}`,
    clean: result4.passed ? "PASS" : `FAIL at ${result4.failedAt}`,
  }, "Results");

  await cache.disconnect();
}

testSafety().catch(console.error);