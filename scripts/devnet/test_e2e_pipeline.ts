/**
 * E2E Trading Pipeline Test
 *
 * Boots the TradingEngine and runs a single tick().
 * The engine discovers ALL pools, collects ALL opportunities,
 * then processes each one through: safety → route → guard → execute.
 *
 * PREREQUISITES:
 *   - npx ts-node scripts/devnet/create_dirty_pool.ts  (run once)
 *   - redis-server running
 *   - npx ts-node scripts/devnet/populate_caches.ts    (run once)
 */

import { Connection } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import fs from "fs";

import { TradingEngine, TickResult } from "../../src/engine/trading_engine";
import { ProtectionManager } from "../../src/protection/protection_manager";
import { CacheManager } from "../../src/cache/cache_manager";
import { loadWallet } from "../../src/utils/wallet";
import { getConfig } from "../../src/utils/config";
import { logger } from "../../src/utils/logger";

const SEP = "─".repeat(60);

async function main() {
  const cfg = getConfig();

  // ── Boot infrastructure ──────────────────────────────
  const connection = new Connection(cfg.network.rpc_url, {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 60000,
  });
  const wallet = loadWallet();
  const provider = new AnchorProvider(connection, new Wallet(wallet), { commitment: "confirmed" });

  const ammIdl = JSON.parse(fs.readFileSync("programs-amm/target/idl/programs_amm.json", "utf-8"));
  const flashIdl = JSON.parse(fs.readFileSync("programs-protection/target/idl/programs_protection.json", "utf-8"));
  const ammProgram = new Program(ammIdl, provider) as any;
  const flashProgram = new Program(flashIdl, provider) as any;

  const pools = JSON.parse(fs.readFileSync("config/devnet_pools.json", "utf-8"));
  const tokens = JSON.parse(fs.readFileSync("config/devnet_tokens.json", "utf-8"));
  const dirtyTokens = JSON.parse(fs.readFileSync("config/devnet_dirty_tokens.json", "utf-8"));

  const cache = new CacheManager();
  const redisPong = await cache.ping();
  if (!redisPong) {
    logger.error("Redis is not running! Start it with: redis-server");
    process.exit(1);
  }

  const protection = new ProtectionManager({
    autoPause: { maxConsecutiveFailures: cfg.protection.max_consecutive_failures },
    drawdown: {
      dailyLimit: cfg.capital.daily_limit_usd,
      autoPausePercent: cfg.protection.drawdown_pause_pct,
    },
    slippage: { maxSlippageBps: cfg.protection.slippage_max_bps },
    tradingHours: { enabled: false, startHour: 0, endHour: 23 },
  });

  // ── Create engine ────────────────────────────────────
  const engine = new TradingEngine({
    connection,
    ammProgram,
    flashProgram,
    pools,
    tokens,
    dirtyTokens,
    cache,
    protection,
  });

  // ── Create price gap if needed ───────────────────────
  // The triangular arb needs a price imbalance to be profitable.
  // If there's no natural arb, create one.
  logger.info("Creating price gap to ensure arb opportunity exists...");
  await engine.createPriceGap();

  // ── Run ONE tick ─────────────────────────────────────
  logger.info(SEP);
  logger.info("  RUNNING engine.tick() — single pass");
  logger.info(SEP);

  const result: TickResult = await engine.tick();

  // ── Assert results ───────────────────────────────────
  logger.info("\n" + SEP);
  logger.info("  E2E ASSERTIONS");
  logger.info(SEP);

  const checks: { label: string; passed: boolean; detail: string }[] = [];

  function assert(label: string, passed: boolean, detail: string) {
    checks.push({ label, passed, detail });
    logger.info(`  ${passed ? "PASS" : "FAIL"}  ${label}  →  ${detail}`);
  }

  // 1. Pools scanned
  assert(
    "Pools scanned",
    result.poolsScanned >= 4,
    `${result.poolsScanned} pools`,
  );

  // 2. Opportunities found (dirty + clean)
  assert(
    "Opportunities found",
    result.opportunitiesFound >= 2,
    `${result.opportunitiesFound} opportunities`,
  );

  // 3. Safety rejected at least one (dirty pool)
  assert(
    "Safety rejected dirty token",
    result.safetyRejected >= 1,
    `${result.safetyRejected} rejected`,
  );

  // 4. At least one trade executed
  assert(
    "Trade executed",
    result.tradesExecuted >= 1,
    `${result.tradesExecuted} executed`,
  );

  // 5. Check details for dirty rejection
  const dirtyRejection = result.details.find(d => d.stage === "safety_rejected");
  assert(
    "Dirty pool caught by safety",
    !!dirtyRejection,
    dirtyRejection ? `${dirtyRejection.opportunity} — ${dirtyRejection.reason}` : "no rejection found",
  );

  // 6. Check details for successful execution
  const executed = result.details.find(d => d.stage === "executed");
  assert(
    "Clean arb executed with profit",
    !!executed && (executed.profit ?? 0) > 0,
    executed ? `profit=+${executed.profit?.toFixed(4)} fUSDC  tx=${executed.signature?.slice(0, 16)}...` : "no execution",
  );

  // 7. Protection state is healthy
  const protStatus = engine.getProtectionStatus();
  assert(
    "Protection state healthy",
    !protStatus.autoPause.isPaused,
    `paused=${protStatus.autoPause.isPaused}, drawdown=${JSON.stringify(protStatus.drawdown)}`,
  );

  // ── Final summary ────────────────────────────────────
  logger.info("\n" + SEP);
  const allPassed = checks.every(c => c.passed);
  const passCount = checks.filter(c => c.passed).length;
  logger.info(allPassed
    ? `  ALL ${passCount}/${checks.length} CHECKS PASSED`
    : `  ${passCount}/${checks.length} CHECKS PASSED — SOME FAILED`,
  );
  logger.info(SEP);

  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  logger.error({ err }, "E2E test crashed");
  process.exit(1);
});
