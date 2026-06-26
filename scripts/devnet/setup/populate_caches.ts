import { CacheManager } from "../../../src/cache/cache_manager";
import { SentimentCache } from "../../../src/cache/sentiment_cache";
import { WhaleCache } from "../../../src/cache/whale_cache";
import { RegimeCache } from "../../../src/cache/regime_cache";
import { TokenScoreCache } from "../../../src/cache/token_score_cache";
import { EMATracker } from "../../../src/cache/ema_tracker";
import { logger } from "../../../src/utils/logger";
import fs from "fs";

async function populateCaches() {
  const cache = new CacheManager();
  const sentiment = new SentimentCache(cache);
  const whale = new WhaleCache(cache);
  const regime = new RegimeCache(cache);
  const tokenScore = new TokenScoreCache(cache);
  const ema = new EMATracker(cache);

  const tokens = JSON.parse(fs.readFileSync("config/devnet_tokens.json", "utf-8"));

  logger.info("Populating caches with synthetic data...");

  // Sentiment data
  await sentiment.set(tokens.tokenA.mint, {
    token: tokens.tokenA.mint,
    score: 0.6,
    volume: 1500,
    sources: ["twitter", "telegram"],
    updatedAt: Date.now(),
  });
  await sentiment.set(tokens.tokenB.mint, {
    token: tokens.tokenB.mint,
    score: 0.8,
    volume: 3200,
    sources: ["twitter", "reddit", "telegram"],
    updatedAt: Date.now(),
  });
  await sentiment.set(tokens.tokenC.mint, {
    token: tokens.tokenC.mint,
    score: -0.2,
    volume: 400,
    sources: ["twitter"],
    updatedAt: Date.now(),
  });
  logger.info("Sentiment cache populated");

  // Whale data
  await whale.set("whale_wallet_001", {
    wallet: "whale_wallet_001",
    action: "accumulating",
    token: tokens.tokenB.mint,
    amount: 50000,
    confidence: 0.85,
    updatedAt: Date.now(),
  });
  await whale.set("whale_wallet_002", {
    wallet: "whale_wallet_002",
    action: "distributing",
    token: tokens.tokenC.mint,
    amount: 120000,
    confidence: 0.72,
    updatedAt: Date.now(),
  });
  await whale.set("whale_wallet_003", {
    wallet: "whale_wallet_003",
    action: "holding",
    token: tokens.tokenA.mint,
    amount: 500000,
    confidence: 0.95,
    updatedAt: Date.now(),
  });
  logger.info("Whale cache populated");

  // Regime/direction predictions
  await regime.set(tokens.tokenB.mint, "5m", {
    token: tokens.tokenB.mint,
    predictedDirection: "up",
    predictedChange: 2.5,
    confidence: 0.78,
    timeframe: "5m",
    updatedAt: Date.now(),
  });
  await regime.set(tokens.tokenB.mint, "1h", {
    token: tokens.tokenB.mint,
    predictedDirection: "up",
    predictedChange: 5.1,
    confidence: 0.65,
    timeframe: "1h",
    updatedAt: Date.now(),
  });
  await regime.set(tokens.tokenC.mint, "5m", {
    token: tokens.tokenC.mint,
    predictedDirection: "down",
    predictedChange: -1.8,
    confidence: 0.71,
    timeframe: "5m",
    updatedAt: Date.now(),
  });
  logger.info("Regime cache populated");

  // Token safety scores
  await tokenScore.set(tokens.tokenA.mint, {
    token: tokens.tokenA.mint,
    overallScore: 92,
    liquidityLocked: true,
    mintAuthorityRevoked: true,
    devWalletPercent: 5,
    isHoneypot: false,
    anomalyScore: 0.1,
    updatedAt: Date.now(),
  });
  await tokenScore.set(tokens.tokenB.mint, {
    token: tokens.tokenB.mint,
    overallScore: 88,
    liquidityLocked: true,
    mintAuthorityRevoked: true,
    devWalletPercent: 8,
    isHoneypot: false,
    anomalyScore: 0.15,
    updatedAt: Date.now(),
  });
  await tokenScore.set(tokens.tokenC.mint, {
    token: tokens.tokenC.mint,
    overallScore: 85,
    liquidityLocked: true,
    mintAuthorityRevoked: true,
    devWalletPercent: 10,
    isHoneypot: false,
    anomalyScore: 0.2,
    updatedAt: Date.now(),
  });

  // Load dirty tokens and score them low
  const dirty = JSON.parse(fs.readFileSync("config/devnet_dirty_tokens.json", "utf-8"));
  await tokenScore.set(dirty.dirty1_mint_authority.mint, {
    token: dirty.dirty1_mint_authority.mint,
    overallScore: 15,
    liquidityLocked: false,
    mintAuthorityRevoked: false,
    devWalletPercent: 0,
    isHoneypot: false,
    anomalyScore: 0.85,
    updatedAt: Date.now(),
  });
  await tokenScore.set(dirty.dirty2_dev_heavy.mint, {
    token: dirty.dirty2_dev_heavy.mint,
    overallScore: 22,
    liquidityLocked: false,
    mintAuthorityRevoked: true,
    devWalletPercent: 90,
    isHoneypot: false,
    anomalyScore: 0.7,
    updatedAt: Date.now(),
  });
  logger.info("Token score cache populated");

  // EMA records
  await ema.recordTrade("arbitrage", tokens.tokenB.mint, "pool1", true);
  await ema.recordTrade("arbitrage", tokens.tokenB.mint, "pool1", true);
  await ema.recordTrade("arbitrage", tokens.tokenB.mint, "pool1", false);
  await ema.recordTrade("momentum", tokens.tokenB.mint, "pool1", true);
  await ema.recordTrade("momentum", tokens.tokenC.mint, "pool2", false);
  logger.info("EMA tracker populated");

  // Verify reads
  logger.info("--- Verifying cache reads ---");

  const sentimentA = await sentiment.get(tokens.tokenA.mint);
  logger.info({ token: "fUSDC", score: sentimentA?.score }, "Sentiment read");

  const whaleData = await whale.get("whale_wallet_001");
  logger.info({ wallet: "whale_001", action: whaleData?.action }, "Whale read");

  const regimePred = await regime.get(tokens.tokenB.mint, "5m");
  logger.info({ token: "fSOL", direction: regimePred?.predictedDirection }, "Regime read");

  const safeCheck = await tokenScore.isSafe(tokens.tokenA.mint);
  logger.info({ token: "fUSDC", safe: safeCheck }, "Token safety read");

  const dirtyCheck = await tokenScore.isSafe(dirty.dirty1_mint_authority.mint);
  logger.info({ token: "dirty1", safe: dirtyCheck }, "Dirty token safety read");

  const emaRecord = await ema.get("arbitrage", tokens.tokenB.mint, "pool1");
  logger.info({ strategy: "arbitrage", successRate: emaRecord?.successRate?.toFixed(3) }, "EMA read");

  logger.info("=== All caches populated and verified ===");

  await cache.disconnect();
}

populateCaches().catch(console.error);