import { ProtectionManager } from "../../src/protection/protection_manager";
import { logger } from "../../src/utils/logger";

async function testProtection() {
  const protection = new ProtectionManager({
    autoPause: { maxConsecutiveFailures: 3 },
    drawdown: { dailyLimit: 1000, autoPausePercent: 90 },
    slippage: { maxSlippageBps: 500 },
    tradingHours: { enabled: false, startHour: 8, endHour: 22 },
  });

  // ============================================================
  // TEST 1: FULL PRE-TRADE CHECK — should pass
  // ============================================================
  logger.info("=== Test 1: Pre-trade check (should pass) ===");
  const check1 = protection.canExecuteTrade(100);
  logger.info({ result: check1 }, "Pre-trade check");

  // ============================================================
  // TEST 2: SLIPPAGE CALCULATION
  // ============================================================
  logger.info("=== Test 2: Slippage ===");
  const minOutput = protection.getMinimumOutput(1000);
  logger.info({ expected: 1000, minimum: minOutput, maxSlippage: "5%" }, "Slippage calculation");

  const goodSlippage = protection.slippage.check(980, minOutput);
  logger.info({ actual: 980, minimum: minOutput, passed: goodSlippage }, "Good slippage");

  const badSlippage = protection.slippage.check(940, minOutput);
  logger.info({ actual: 940, minimum: minOutput, passed: badSlippage }, "Bad slippage");

  // ============================================================
  // TEST 3: DRAWDOWN LIMIT
  // ============================================================
  logger.info("=== Test 3: Drawdown ===");
  const check2 = protection.canExecuteTrade(400);
  logger.info({ result: check2 }, "Request 400 (total: 500/1000)");

  const check3 = protection.canExecuteTrade(400);
  logger.info({ result: check3 }, "Request 400 (total: 900/1000)");

  // This should trigger auto-pause at 90%
  const check4 = protection.canExecuteTrade(100);
  logger.info({ result: check4 }, "Request 100 (total: 1000/1000 — should pause)");

  // This should be blocked
  const check5 = protection.canExecuteTrade(1);
  logger.info({ result: check5 }, "Request 1 more (should be blocked)");

  // ============================================================
  // TEST 4: AUTO-PAUSE
  // ============================================================
  logger.info("=== Test 4: Auto-Pause ===");

  protection.recordResult(false);
  protection.recordResult(false);
  logger.info("Recorded 2 failures");

  // Reset drawdown to test auto-pause independently
  protection.drawdown = new (await import("../../src/protection/drawdown")).Drawdown({
    dailyLimit: 1000, autoPausePercent: 90,
  });

  const check6 = protection.canExecuteTrade(10);
  logger.info({ result: check6 }, "After 2 failures (should still pass)");

  protection.recordResult(false);
  logger.info("Recorded failure 3");

  const check7 = protection.canExecuteTrade(10);
  logger.info({ result: check7 }, "After 3 failures (should be blocked)");

  // Reset and verify
  protection.autoPause.reset();
  const check8 = protection.canExecuteTrade(10);
  logger.info({ result: check8 }, "After reset (should pass)");

  // ============================================================
  // TEST 5: TRADING HOURS
  // ============================================================
  logger.info("=== Test 5: Trading Hours ===");
  protection.tradingHours.update({ enabled: true, startHour: 0, endHour: 1 });
  const currentHour = new Date().getHours();

  const check9 = protection.canExecuteTrade(0);
  logger.info({
    result: check9,
    currentHour,
    window: "0-1",
  }, "Trading hours test (probably blocked unless midnight)");

  protection.tradingHours.update({ enabled: true, startHour: 0, endHour: 23 });
  const check10 = protection.canExecuteTrade(0);
  logger.info({ result: check10 }, "Trading hours 0-23 (should pass)");

  // ============================================================
  // STATUS
  // ============================================================
  logger.info("=== Full Status ===");
  logger.info(protection.getStatus(), "Protection status");

  logger.info("=== All off-chain protection tests complete ===");
}

testProtection().catch(console.error);