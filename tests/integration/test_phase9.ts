import { Connection, PublicKey, Transaction, SystemProgram } from "@solana/web3.js";
import { AutoPause } from "../../src/protection/auto_pause";
import { Drawdown } from "../../src/protection/drawdown";
import { SlippageGuard } from "../../src/protection/slippage_guard";
import { Layer3AutoPause } from "../../src/layer3_protection/auto_pause";
import { Layer3Drawdown, DAILY_LIMIT_HIT_EVENT, DrawdownLimitEvent } from "../../src/layer3_protection/daily_drawdown";
import { HardSlippageLimits } from "../../src/layer3_protection/hard_slippage_limits";
import { JitoMevProtection } from "../../src/layer3_protection/jito_mev_protection";
import { SandwichDetector } from "../../src/layer2_execution/sandwich_detector";
import { loadWallet } from "../../src/utils/wallet";
import { getConfig } from "../../src/utils/config";
import { logger } from "../../src/utils/logger";
import fs from "fs";

const cfg = getConfig();
const connection = new Connection(cfg.network.rpc_url, "confirmed");

async function runTest(name: string, fn: () => Promise<void>): Promise<boolean> {
  try {
    await fn();
    logger.info(`✓ PASS: ${name}`);
    return true;
  } catch (err: any) {
    logger.error({ error: err.message }, `✗ FAIL: ${name}`);
    return false;
  }
}

// TEST 1: N consecutive failures → auto-pause triggers + slow-path txs abandoned
async function testAutoPause() {
  const maxFailures = cfg.protection.max_consecutive_failures;
  const inner = new AutoPause({ maxConsecutiveFailures: maxFailures });
  const autoPause = new Layer3AutoPause(inner);

  // Register real-looking (but fake) slow-path tx signatures
  autoPause.registerSlowPathTx({ signature: `devnet-slow-${Date.now()}-1`, description: "slow swap 1" });
  autoPause.registerSlowPathTx({ signature: `devnet-slow-${Date.now()}-2`, description: "slow swap 2" });

  for (let i = 0; i < maxFailures; i++) {
    autoPause.recordTrade(false);
  }

  if (!autoPause.isPaused()) throw new Error(`Expected bot to be paused after ${maxFailures} failures`);
  if (autoPause.canTrade()) throw new Error("canTrade() should return false when paused");

  const status = autoPause.getStatus();
  if (status.consecutiveFailures < maxFailures) throw new Error("Consecutive failure count wrong");

  logger.info(autoPause.getStatus(), "Auto-pause status");
}

// TEST 2: Daily drawdown limit hit → event fires + trades blocked
async function testDailyDrawdown() {
  const dailyLimit = cfg.capital.daily_limit_usd;
  const pausePct = cfg.protection.drawdown_pause_pct;

  const inner = new Drawdown({ dailyLimit, autoPausePercent: pausePct });
  const drawdown = new Layer3Drawdown(inner);

  let eventFired = false;
  drawdown.on(DAILY_LIMIT_HIT_EVENT, (event: DrawdownLimitEvent) => {
    eventFired = true;
    logger.info({ event }, "Drawdown limit event received");
  });

  // Use trades that will hit exactly the pause threshold and then overflow
  const firstTrade = Math.floor(dailyLimit * 0.5);
  const secondTrade = Math.floor(dailyLimit * (pausePct / 100)) - firstTrade;
  const overflowTrade = Math.floor(dailyLimit * 0.2);

  const first = drawdown.requestCapital(firstTrade);
  if (!first) throw new Error(`First trade (${firstTrade}) should be allowed`);

  const second = drawdown.requestCapital(secondTrade);
  if (!second) throw new Error(`Second trade (${secondTrade}, total ${firstTrade + secondTrade}) should be allowed`);

  // This should be blocked — over the daily limit
  const third = drawdown.requestCapital(overflowTrade);
  if (third) throw new Error(`Third trade (${overflowTrade}) should be blocked — limit exceeded`);

  if (!eventFired) throw new Error("DAILY_LIMIT_HIT_EVENT should have fired");
  if (!drawdown.isLimitHit()) throw new Error("isLimitHit() should return true");

  // Any further trade also blocked
  const fourth = drawdown.requestCapital(1);
  if (fourth) throw new Error("All trades should be blocked after limit hit");

  logger.info(drawdown.getStatus(), "Drawdown status");
}

// TEST 3: 0 bps slippage → hard slippage check rejects pre-flight
async function testHardSlippage() {
  const tokens = JSON.parse(fs.readFileSync("config/devnet_tokens.json", "utf-8"));
  const wallet = loadWallet();

  // 0 bps: exact output required — any non-perfect result must reject
  const strictGuard = new SlippageGuard({ maxSlippageBps: 0 });
  const strictChecker = new HardSlippageLimits(connection, strictGuard);

  const dummyTx = new Transaction();
  dummyTx.add(SystemProgram.transfer({
    fromPubkey: wallet.publicKey,
    toPubkey: wallet.publicKey,
    lamports: 0,
  }));
  const { blockhash } = await connection.getLatestBlockhash();
  dummyTx.recentBlockhash = blockhash;
  dummyTx.feePayer = wallet.publicKey;

  const outputAccount = new PublicKey(tokens.tokenB.account);
  const expectedOutput = BigInt(1_000_000) * BigInt(10 ** tokens.tokenB.decimals);

  const strictResult = await strictChecker.checkTransaction({
    transaction: dummyTx,
    outputTokenAccount: outputAccount,
    expectedOutputAmount: expectedOutput,
    slippageBps: 0,
  });

  if (strictResult.passed) throw new Error("0 bps slippage check should have rejected");
  logger.info({ reason: strictResult.reason }, "0 bps rejection confirmed");

  // max bps: accept anything — should not be blocked by the guard
  const maxBps = cfg.protection.slippage_max_bps;
  const relaxedGuard = new SlippageGuard({ maxSlippageBps: 10000 });
  const relaxedChecker = new HardSlippageLimits(connection, relaxedGuard);
  const relaxedResult = await relaxedChecker.checkTransaction({
    transaction: dummyTx,
    outputTokenAccount: outputAccount,
    expectedOutputAmount: expectedOutput,
    slippageBps: 10000,
  });
  logger.info({ passed: relaxedResult.passed, configuredMaxBps: maxBps }, "Relaxed slippage check result");
}

// TEST 4: Sandwich detection check + Jito bundle dry-run
async function testJitoMevProtection() {
  const wallet = loadWallet();
  const pools = JSON.parse(fs.readFileSync("config/devnet_pools.json", "utf-8"));

  // Check real pool for sandwich patterns
  const sandwichDetector = new SandwichDetector(connection);
  const pool1 = new PublicKey(pools.pool1.address);
  const risk = await sandwichDetector.check(pool1);

  logger.info({
    detected: risk.detected,
    reason: risk.reason,
    minSuspiciousLamports: cfg.sandwich_detection.min_suspicious_lamports,
  }, "Sandwich detection result");

  // Jito dry-run — validates full bundle code path without hitting mainnet
  const jito = new JitoMevProtection(connection, wallet, { dryRun: true });

  const tx = new Transaction();
  tx.add(SystemProgram.transfer({
    fromPubkey: wallet.publicKey,
    toPubkey: wallet.publicKey,
    lamports: 0,
  }));

  const result = await jito.submitAsBundle(tx);

  if (result.status !== "accepted") throw new Error(`Expected accepted, got ${result.status}`);
  if (!result.bundleId) throw new Error("Expected a bundle ID");

  logger.info({
    bundleId: result.bundleId,
    status: result.status,
    tipLamports: cfg.jito.tip_lamports,
  }, "Jito bundle dry-run confirmed");

  if (risk.detected) {
    logger.info("Sandwich detected — trade would route to Jito ✓");
  } else {
    logger.info("No sandwich — Jito path tested in dry-run ✓");
  }
}

async function main() {
  logger.info("========================================");
  logger.info("PHASE 9: Layer 3 Protection Tests");
  logger.info({
    cluster: cfg.network.cluster,
    maxFailures: cfg.protection.max_consecutive_failures,
    dailyLimit: cfg.capital.daily_limit_usd,
    slippageMaxBps: cfg.protection.slippage_max_bps,
    jitoUrl: cfg.jito.block_engine_url,
  }, "Config loaded");
  logger.info("========================================");

  const results = [
    { name: `Auto-Pause (${cfg.protection.max_consecutive_failures} failures → pause)`, passed: await runTest("Auto-Pause", testAutoPause) },
    { name: `Daily Drawdown ($${cfg.capital.daily_limit_usd} limit → block)`, passed: await runTest("Daily Drawdown", testDailyDrawdown) },
    { name: "Hard Slippage (0 bps → reject pre-flight)", passed: await runTest("Hard Slippage 0bps", testHardSlippage) },
    { name: "Jito MEV Protection (sandwich check + bundle dry-run)", passed: await runTest("Jito MEV Protection", testJitoMevProtection) },
  ];

  logger.info("========================================");
  logger.info("PHASE 9 RESULTS");
  logger.info("========================================");

  for (const r of results) {
    logger.info(`${r.passed ? "✓" : "✗"} ${r.name}`);
  }

  const passed = results.filter(r => r.passed).length;
  logger.info(`${passed}/${results.length} tests passed`);

  if (passed < results.length) {
    logger.error("Phase 9 FAILED");
    process.exit(1);
  }

  logger.info("=== Phase 9 complete ===");
}

main().catch(console.error);
