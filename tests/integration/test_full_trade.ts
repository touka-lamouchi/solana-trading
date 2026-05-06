import { Connection, PublicKey } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet, BN } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { ArbitrageDetector } from "../../src/layer1_opportunity/pure_code/arbitrage_detector";
import { OpportunityRouter } from "../../src/layer1_opportunity/opportunity_router";
import { RoutePlanner } from "../../src/layer2_execution/route_planner";
import { TransactionBuilder } from "../../src/layer2_execution/transaction_builder";
import { TxSubmitter } from "../../src/layer3_protection/tx_submitter";
import { ProtectionManager } from "../../src/protection/protection_manager";
import { loadWallet } from "../../src/utils/wallet";
import { getConfig, getStrategyConfig } from "../../src/utils/config";
import { logger } from "../../src/utils/logger";
import fs from "fs";

const ammIdl = JSON.parse(
  fs.readFileSync("programs-amm/target/idl/programs_amm.json", "utf-8")
);
const flashIdl = JSON.parse(
  fs.readFileSync("programs-protection/target/idl/programs_protection.json", "utf-8")
);

async function testFullTrade() {
  const cfg = getConfig();
  const strategyCfg = getStrategyConfig();

  const connection = new Connection(cfg.network.rpc_url, {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 60000,
  });
  const wallet = loadWallet();
  const provider = new AnchorProvider(connection, new Wallet(wallet), { commitment: "confirmed" });

  const ammProgram = new Program(ammIdl, provider) as any;
  const flashProgram = new Program(flashIdl, provider) as any;

  const pools = JSON.parse(fs.readFileSync("config/devnet_pools.json", "utf-8"));
  const tokens = JSON.parse(fs.readFileSync("config/devnet_tokens.json", "utf-8"));

  const protection = new ProtectionManager({
    autoPause: { maxConsecutiveFailures: cfg.protection.max_consecutive_failures },
    drawdown: {
      dailyLimit: cfg.capital.daily_limit_usd,
      autoPausePercent: cfg.protection.drawdown_pause_pct,
    },
    slippage: { maxSlippageBps: cfg.protection.slippage_max_bps },
    tradingHours: { enabled: cfg.trading_hours.enabled, startHour: 0, endHour: 23 },
  });

  const txBuilder = new TransactionBuilder(connection, ammProgram, protection.slippage, tokens, wallet);
  const submitter = new TxSubmitter(txBuilder, protection);
  const router = new OpportunityRouter();

  // Swap amount: cap at max_per_trade_usd from config
  const swapAmount = Math.min(50, cfg.capital.max_per_trade_usd);

  // ============================================================
  // PART 1: SIMPLE SWAP (own capital)
  // ============================================================
  logger.info("========================================");
  logger.info(`PART 1: Simple Swap (${swapAmount} ${tokens.tokenA.name} → ${tokens.tokenB.name})`);
  logger.info("========================================");

  const beforeA = await connection.getTokenAccountBalance(new PublicKey(tokens.tokenA.account));
  const beforeB = await connection.getTokenAccountBalance(new PublicKey(tokens.tokenB.account));
  logger.info({
    [tokens.tokenA.name]: beforeA.value.uiAmountString,
    [tokens.tokenB.name]: beforeB.value.uiAmountString,
  }, "Before");

  const routePlanner = new RoutePlanner(pools);
  const simpleRoute = routePlanner.planSingleHop("pool1", swapAmount, true, 0.3);

  const simpleTx = await txBuilder.buildSwapTransaction(simpleRoute, pools, 0);
  const simpleResult = await submitter.submit(simpleTx, swapAmount, "slow");

  const afterA = await connection.getTokenAccountBalance(new PublicKey(tokens.tokenA.account));
  const afterB = await connection.getTokenAccountBalance(new PublicKey(tokens.tokenB.account));
  logger.info({
    [tokens.tokenA.name]: afterA.value.uiAmountString,
    [tokens.tokenB.name]: afterB.value.uiAmountString,
  }, "After");

  if (simpleResult.success) {
    logger.info("Simple swap: SUCCESS");
  } else {
    logger.error({ reason: simpleResult.reason }, "Simple swap: FAILED");
  }

  // ============================================================
  // PART 2: DETECT ARB OPPORTUNITY
  // ============================================================
  logger.info("========================================");
  logger.info("PART 2: Detect Arbitrage Opportunity");
  logger.info("========================================");

  // Use min_profit_pct from strategy config — arb detector reads it from config internally
  const arbDetector = new ArbitrageDetector(connection);
  const borrowAmount = Math.min(100, cfg.capital.flash_loan_max_usd);
  const opportunities = await arbDetector.scan(pools, [borrowAmount]);

  if (opportunities.length === 0) {
    logger.info("No arb found — creating one with simulator...");

    await ammProgram.methods
      .swap(
        new BN(5000 * 10 ** tokens.tokenA.decimals),
        new BN(1),
        true
      )
      .accounts({
        pool: new PublicKey(pools.pool1.address),
        tokenAVault: new PublicKey(pools.pool1.tokenAVault),
        tokenBVault: new PublicKey(pools.pool1.tokenBVault),
        userTokenA: new PublicKey(tokens.tokenA.account),
        userTokenB: new PublicKey(tokens.tokenB.account),
        user: wallet.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    logger.info(`Price gap created on ${pools.pool1.name}`);

    const newOpps = await arbDetector.scan(pools, [borrowAmount]);
    if (newOpps.length > 0) opportunities.push(...newOpps);
  }

  if (opportunities.length === 0) {
    logger.error("Still no arb found — skipping flash loan test");
    return;
  }

  const bestArb = opportunities[0]!;
  const routed = router.route(bestArb);
  logger.info({
    path: bestArb.path,
    profit: bestArb.expectedProfit.toFixed(4),
    profitPercent: bestArb.profitPercent.toFixed(2) + "%",
    minProfitPct: strategyCfg.strategies.crypto_arbitrage.min_profit_pct + "%",
    routedPath: routed.path,
  }, "Best opportunity found");

  // ============================================================
  // PART 3: FLASH LOAN ARBITRAGE
  // ============================================================
  logger.info("========================================");
  logger.info("PART 3: Flash Loan Arbitrage");
  logger.info("========================================");

  let flashVaultConfig: any;
  try {
    flashVaultConfig = JSON.parse(fs.readFileSync("config/devnet_flash_vault.json", "utf-8"));
  } catch {
    logger.error("Flash vault not set up — run setup_flash_vault.ts first");
    return;
  }

  const beforeFlashA = await connection.getTokenAccountBalance(new PublicKey(tokens.tokenA.account));
  logger.info({ [tokens.tokenA.name]: beforeFlashA.value.uiAmountString }, "Before flash loan arb");

  // Calculate arb route outputs using AMM fee from config
  const pool1State = await arbDetector.getPoolState(pools.pool1);
  const pool2State = await arbDetector.getPoolState(pools.pool2);
  const pool3State = await arbDetector.getPoolState(pools.pool3);

  const feeNum = cfg.amm.fee_numerator;
  const feeDen = cfg.amm.fee_denominator;
  const calcOutput = (amtIn: number, resIn: number, resOut: number) => {
    const fee = amtIn * feeNum;
    return (fee * resOut) / (resIn * feeDen + fee);
  };

  const step1Out = calcOutput(borrowAmount, pool3State.reserveA, pool3State.reserveB);
  const step2Out = calcOutput(step1Out, pool2State.reserveB, pool2State.reserveA);
  const step3Out = calcOutput(step2Out, pool1State.reserveB, pool1State.reserveA);

  logger.info({
    borrow: borrowAmount + ` ${tokens.tokenA.name}`,
    step1: step1Out.toFixed(4) + ` ${tokens.tokenC.name}`,
    step2: step2Out.toFixed(6) + ` ${tokens.tokenB.name}`,
    step3: step3Out.toFixed(4) + ` ${tokens.tokenA.name}`,
    profit: (step3Out - borrowAmount).toFixed(4) + ` ${tokens.tokenA.name}`,
  }, "Flash loan arb calculation");

  if (step3Out <= borrowAmount) {
    logger.warn("Arb not profitable after calculation — skipping flash loan execution");
    logger.info("=== Phase 7 test complete (simple swap succeeded, arb detected) ===");
    return;
  }

  const arbRoute = routePlanner.planTriangularArb(
    borrowAmount, step1Out, step2Out, step3Out, true
  );

  const flashTx = await txBuilder.buildFlashLoanArbTransaction(
    arbRoute,
    pools,
    flashProgram,
    flashVaultConfig.flashConfig,
    flashVaultConfig.vault,
    borrowAmount,
    tokens.tokenA.decimals
  );

  const flashResult = await submitter.submit(flashTx, 0, "fast");

  const afterFlashA = await connection.getTokenAccountBalance(new PublicKey(tokens.tokenA.account));
  logger.info({ [tokens.tokenA.name]: afterFlashA.value.uiAmountString }, "After flash loan arb");

  if (flashResult.success) {
    const profit = parseFloat(afterFlashA.value.uiAmountString!) - parseFloat(beforeFlashA.value.uiAmountString!);
    logger.info({
      profit: profit.toFixed(4) + ` ${tokens.tokenA.name}`,
      signature: flashResult.signature,
    }, "FLASH LOAN ARB: SUCCESS — PROFIT MADE WITH ZERO CAPITAL");
  } else {
    logger.error({ reason: flashResult.reason }, "Flash loan arb: FAILED");
  }

  // ============================================================
  // SUMMARY
  // ============================================================
  logger.info("========================================");
  logger.info("PHASE 7 SUMMARY");
  logger.info("========================================");
  logger.info({
    cluster: cfg.network.cluster,
    simpleSwap: simpleResult.success ? "SUCCESS" : "FAILED",
    arbDetected: opportunities.length > 0 ? "YES" : "NO",
    flashLoanArb: flashResult?.success ? "SUCCESS" : "FAILED or SKIPPED",
  }, "Results");

  logger.info(protection.getStatus(), "Protection status");
  logger.info("=== Phase 7 complete ===");
}

testFullTrade().catch(console.error);
