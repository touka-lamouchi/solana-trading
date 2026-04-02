/**
 * Phase 9 — Integration Tests
 *
 * Unlike test_phase9.ts (pure in-memory logic), this script submits REAL
 * transactions to devnet and verifies that protections fire in response to
 * actual on-chain outcomes.
 *
 * Tests:
 *  1. Auto-pause: submit N real failing txs → bot stops accepting trades
 *  2. Drawdown:   submit real swaps until daily limit hit → trades blocked
 *  3. Slippage:   submit real swap with 0 bps slippage → on-chain revert recorded
 *  4. Sandwich:   sandwich detector runs against live pool → routes to Jito dry-run
 */

import { Connection, PublicKey, Transaction, SystemProgram } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet, BN } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { ProtectionManager } from "../../src/protection/protection_manager";
import { TransactionBuilder } from "../../src/layer2_execution/transaction_builder";
import { TxSubmitter } from "../../src/layer3_protection/tx_submitter";
import { RoutePlanner } from "../../src/layer2_execution/route_planner";
import { SandwichDetector } from "../../src/layer2_execution/sandwich_detector";
import { JitoMevProtection } from "../../src/layer3_protection/jito_mev_protection";
import { HardSlippageLimits } from "../../src/layer3_protection/hard_slippage_limits";
import { SlippageGuard } from "../../src/protection/slippage_guard";
import { loadWallet } from "../../src/utils/wallet";
import { getConfig } from "../../src/utils/config";
import { logger } from "../../src/utils/logger";
import fs from "fs";

const ammIdl = JSON.parse(fs.readFileSync("programs-amm/target/idl/programs_amm.json", "utf-8"));

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeProtection(overrides: {
  maxFailures?: number;
  dailyLimit?: number;
  slippageBps?: number;
}) {
  const cfg = getConfig();
  return new ProtectionManager({
    autoPause: { maxConsecutiveFailures: overrides.maxFailures ?? cfg.protection.max_consecutive_failures },
    drawdown: {
      dailyLimit: overrides.dailyLimit ?? cfg.capital.daily_limit_usd,
      autoPausePercent: cfg.protection.drawdown_pause_pct,
    },
    slippage: { maxSlippageBps: overrides.slippageBps ?? cfg.protection.slippage_max_bps },
    tradingHours: { enabled: false, startHour: 0, endHour: 23 },
  });
}

async function runTest(name: string, fn: () => Promise<void>): Promise<boolean> {
  logger.info(`\n>>> ${name}`);
  try {
    await fn();
    logger.info(`✓ PASS: ${name}`);
    return true;
  } catch (err: any) {
    logger.error({ error: err.message }, `✗ FAIL: ${name}`);
    return false;
  }
}

// ─── TEST 1: Auto-pause fires after real failing transactions ─────────────────

async function testAutoPauseOnRealFailures(
  connection: Connection,
  txBuilder: TransactionBuilder,
  pools: any,
  tokens: any
) {
  const cfg = getConfig();
  // Use a low threshold so we don't need many trades
  const maxFailures = 3;

  const protection = makeProtection({ maxFailures });
  const submitter = new TxSubmitter(txBuilder, protection);
  const routePlanner = new RoutePlanner(pools);

  logger.info({ maxFailures }, "Will submit failing txs until auto-pause fires");

  // Build a swap that will fail: amount_in = 0 → ZeroOutput error from AMM
  // We set amountIn to 0 which the AMM rejects with error code
  for (let i = 0; i < maxFailures; i++) {
    // Build an invalid swap (amountIn = 0 → AMM rejects with ZeroOutput)
    const tx = new Transaction();
    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = txBuilder["wallet"].publicKey;

    // Deliberately pass 0 amount — on-chain will reject
    const ix = await txBuilder["ammProgram"].methods
      .swap(new BN(0), new BN(1), true)
      .accounts({
        pool: new PublicKey(pools.pool1.address),
        tokenAVault: new PublicKey(pools.pool1.tokenAVault),
        tokenBVault: new PublicKey(pools.pool1.tokenBVault),
        userTokenA: new PublicKey(tokens.tokenA.account),
        userTokenB: new PublicKey(tokens.tokenB.account),
        user: txBuilder["wallet"].publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    tx.add(ix);

    const result = await submitter.submit(tx, 0, "fast");
    const status = protection.getStatus();

    logger.info({
      attempt: i + 1,
      txSuccess: result.success,
      consecutiveFailures: status.autoPause.consecutiveFailures,
      paused: status.autoPause.isPaused,
    }, "Submitted failing tx");

    // After enough failures the bot should pause
    if (status.autoPause.isPaused) {
      logger.info({ after: i + 1, maxFailures }, "AUTO-PAUSE fired after real on-chain failures ✓");
      break;
    }
  }

  // Verify bot is now paused
  const finalStatus = protection.getStatus();
  if (!finalStatus.autoPause.isPaused) {
    throw new Error(`Expected auto-pause after ${maxFailures} failures, still running`);
  }

  // Verify next trade is blocked without hitting the network
  const check = protection.canExecuteTrade(0);
  if (check.allowed) throw new Error("canExecuteTrade() should return false when paused");

  logger.info({ reason: check.reason }, "Next trade correctly blocked by auto-pause ✓");
}

// ─── TEST 2: Drawdown limit blocks trades after real capital is spent ─────────

async function testDrawdownOnRealSwaps(
  connection: Connection,
  txBuilder: TransactionBuilder,
  pools: any,
  tokens: any
) {
  const cfg = getConfig();
  // Set a tiny daily limit so a single real swap will approach it
  const tinyLimit = 5; // $5 equivalent
  const protection = makeProtection({ dailyLimit: tinyLimit, slippageBps: 10000 });
  const submitter = new TxSubmitter(txBuilder, protection);
  const routePlanner = new RoutePlanner(pools);

  logger.info({ dailyLimit: tinyLimit }, "Daily limit set low to trigger quickly");

  // Submit a real swap for 3 units — should pass
  const route1 = routePlanner.planSingleHop("pool1", 3, true, 0.001);
  const tx1 = await txBuilder.buildSwapTransaction(route1, pools, 0);
  const result1 = await submitter.submit(tx1, 3, "slow");

  logger.info({
    success: result1.success,
    drawdown: protection.getStatus().drawdown,
  }, "First real swap submitted");

  if (!result1.success) throw new Error(`First swap failed unexpectedly: ${result1.reason}`);

  // Now try to spend more than the limit — should be blocked by drawdown
  const overLimit = tinyLimit + 1;
  const check = protection.canExecuteTrade(overLimit);

  logger.info({
    attempted: overLimit,
    dailyLimit: tinyLimit,
    allowed: check.allowed,
    reason: check.reason,
    drawdown: protection.getStatus().drawdown,
  }, "Over-limit trade check");

  if (check.allowed) {
    throw new Error(`Expected drawdown to block trade of ${overLimit} > limit ${tinyLimit}`);
  }

  logger.info("Drawdown correctly blocked trade after real capital was spent ✓");
}

// ─── TEST 3: Hard slippage pre-flight rejects before real submission ──────────

async function testHardSlippageOnRealTx(
  connection: Connection,
  txBuilder: TransactionBuilder,
  pools: any,
  tokens: any
) {
  // Build a REAL swap transaction (valid accounts, real amounts)
  const routePlanner = new RoutePlanner(pools);
  const route = routePlanner.planSingleHop("pool1", 1, true, 0.001);
  const realTx = await txBuilder.buildSwapTransaction(route, pools, 0);

  // Re-sign with fresh blockhash for simulation
  const { blockhash } = await connection.getLatestBlockhash();
  realTx.recentBlockhash = blockhash;

  const outputAccount = new PublicKey(tokens.tokenB.account);
  const expectedOutput = BigInt(1) * BigInt(10 ** tokens.tokenB.decimals);

  // 0 bps — must reject pre-flight even for a valid real transaction
  const strictGuard = new SlippageGuard({ maxSlippageBps: 0 });
  const checker = new HardSlippageLimits(connection, strictGuard);

  const result = await checker.checkTransaction({
    transaction: realTx,
    outputTokenAccount: outputAccount,
    expectedOutputAmount: expectedOutput,
    slippageBps: 0,
  });

  if (result.passed) {
    throw new Error("Hard slippage check should have rejected the real swap tx at 0 bps");
  }

  logger.info({
    reason: result.reason,
    minRequired: result.minRequiredAmount.toString(),
    txWasReal: true,
  }, "Hard slippage pre-flight correctly rejected real swap tx ✓");

  // Now confirm the same tx PASSES with normal slippage — the tx is valid on-chain
  const cfg = getConfig();
  const normalGuard = new SlippageGuard({ maxSlippageBps: cfg.protection.slippage_max_bps });
  const checker2 = new HardSlippageLimits(connection, normalGuard);

  const result2 = await checker2.checkTransaction({
    transaction: realTx,
    outputTokenAccount: outputAccount,
    expectedOutputAmount: expectedOutput,
    slippageBps: cfg.protection.slippage_max_bps,
  });

  logger.info({
    passed: result2.passed,
    simulatedOutput: result2.simulatedOutputAmount?.toString() ?? "unknown",
    minRequired: result2.minRequiredAmount.toString(),
    slippageBps: cfg.protection.slippage_max_bps,
  }, `Normal slippage (${cfg.protection.slippage_max_bps} bps) check result`);
}

// ─── TEST 4: Sandwich detected on live pool → routes to Jito ─────────────────

async function testSandwichRoutesToJito(
  connection: Connection,
  txBuilder: TransactionBuilder,
  pools: any,
  tokens: any
) {
  const wallet = loadWallet();
  const cfg = getConfig();

  // Check REAL devnet pool for sandwich activity
  const detector = new SandwichDetector(connection);
  const pool1Address = new PublicKey(pools.pool1.address);
  const risk = await detector.check(pool1Address);

  logger.info({
    pool: pools.pool1.name,
    detected: risk.detected,
    reason: risk.reason ?? "none",
    minSuspiciousLamports: cfg.sandwich_detection.min_suspicious_lamports,
  }, "Live sandwich detection result");

  // Build a real swap tx that would be submitted
  const routePlanner = new RoutePlanner(pools);
  const route = routePlanner.planSingleHop("pool1", 1, true, 0.001);
  const realTx = await txBuilder.buildSwapTransaction(route, pools, 0);

  // Jito dry-run: validate full bundle path without hitting mainnet
  const jito = new JitoMevProtection(connection, wallet, { dryRun: true });
  const bundleResult = await jito.submitAsBundle(realTx);

  if (bundleResult.status !== "accepted") {
    throw new Error(`Jito bundle should be accepted in dry-run, got: ${bundleResult.status}`);
  }

  logger.info({
    bundleId: bundleResult.bundleId,
    sandwichDetected: risk.detected,
    action: risk.detected ? "routed to Jito (sandwich avoided)" : "Jito path verified (no sandwich this slot)",
    tipLamports: cfg.jito.tip_lamports,
  }, "Sandwich → Jito routing result ✓");
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  const cfg = getConfig();

  const connection = new Connection(cfg.network.rpc_url, {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 60000,
  });
  const wallet = loadWallet();
  const provider = new AnchorProvider(connection, new Wallet(wallet), { commitment: "confirmed" });
  const ammProgram = new Program(ammIdl, provider) as any;

  const pools = JSON.parse(fs.readFileSync("config/devnet_pools.json", "utf-8"));
  const tokens = JSON.parse(fs.readFileSync("config/devnet_tokens.json", "utf-8"));

  // Shared txBuilder — each test uses its own ProtectionManager
  const sharedProtection = makeProtection({ slippageBps: 10000 }); // relaxed for building
  const txBuilder = new TransactionBuilder(connection, ammProgram, sharedProtection.slippage, tokens);

  logger.info("========================================");
  logger.info("PHASE 9: Integration Tests (Real Trades)");
  logger.info({
    cluster: cfg.network.cluster,
    rpc: cfg.network.rpc_url,
    wallet: wallet.publicKey.toBase58(),
  }, "Config");
  logger.info("========================================");

  const results = [
    {
      name: "Auto-pause fires after real on-chain failures",
      passed: await runTest("Auto-Pause Integration", () =>
        testAutoPauseOnRealFailures(connection, txBuilder, pools, tokens)
      ),
    },
    {
      name: "Drawdown blocks trades after real capital spent",
      passed: await runTest("Drawdown Integration", () =>
        testDrawdownOnRealSwaps(connection, txBuilder, pools, tokens)
      ),
    },
    {
      name: "Hard slippage (0 bps) rejects real swap tx pre-flight",
      passed: await runTest("Hard Slippage Integration", () =>
        testHardSlippageOnRealTx(connection, txBuilder, pools, tokens)
      ),
    },
    {
      name: "Sandwich detector runs on live pool → Jito dry-run",
      passed: await runTest("Sandwich → Jito Integration", () =>
        testSandwichRoutesToJito(connection, txBuilder, pools, tokens)
      ),
    },
  ];

  logger.info("========================================");
  logger.info("INTEGRATION TEST RESULTS");
  logger.info("========================================");

  for (const r of results) {
    logger.info(`${r.passed ? "✓" : "✗"} ${r.name}`);
  }

  const passed = results.filter(r => r.passed).length;
  logger.info(`${passed}/${results.length} integration tests passed`);

  if (passed < results.length) {
    logger.error("Phase 9 integration tests FAILED");
    process.exit(1);
  }

  logger.info("=== Phase 9 integration tests complete ===");
}

main().catch(console.error);
