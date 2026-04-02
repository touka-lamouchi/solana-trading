/**
 * TradingEngine — The bot brain.
 *
 * Each tick():
 *   Phase A: Scan ALL pools → collect ALL opportunities
 *   Phase B: Process each opportunity in priority order:
 *            safety → route → guard → execute
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

import { ArbitrageDetector, ArbOpportunity, PoolState } from "../layer1_opportunity/pure_code/arbitrage_detector";
import { SafetyPipeline } from "../layer1_opportunity/safety_filters/safety_pipeline";
import { OpportunityRouter } from "../layer1_opportunity/opportunity_router";
import { ProtectionManager } from "../protection/protection_manager";
import { TransactionBuilder } from "../layer2_execution/transaction_builder";
import { TxSubmitter } from "../layer3_protection/tx_submitter";
import { RoutePlanner } from "../layer2_execution/route_planner";
import { CacheManager } from "../cache/cache_manager";
import { WhaleCache } from "../cache/whale_cache";
import { WhaleSignal } from "../layer1_opportunity/ai_signals/whale_signal";
import { loadWallet } from "../utils/wallet";
import { getConfig } from "../utils/config";
import { logger } from "../utils/logger";
import fs from "fs";

// ── Types ────────────────────────────────────────────────

export interface TickDetail {
  pool: string;
  opportunity: string;
  stage: "safety_rejected" | "guard_rejected" | "slow_queued" | "executed" | "failed";
  reason?: string;
  profit?: number;
  signature?: string;
}

export interface TickResult {
  poolsScanned: number;
  opportunitiesFound: number;
  safetyRejected: number;
  guardRejected: number;
  tradesExecuted: number;
  tradesFailed: number;
  details: TickDetail[];
}

interface DiscoveredOpportunity {
  arb: ArbOpportunity;
  poolStates: PoolState[];
  involvedMints: string[];   // non-base-token mints to safety-check
  poolKeys: string[];        // keys in devnet_pools.json
  isTriangular: boolean;
}

// ── Engine ───────────────────────────────────────────────

export class TradingEngine {
  private connection: Connection;
  private ammProgram: any;
  private flashProgram: any;
  private pools: any;
  private tokens: any;
  private dirtyTokens: any;

  private arbDetector: ArbitrageDetector;
  private safety: SafetyPipeline;
  private router: OpportunityRouter;
  private protection: ProtectionManager;
  private txBuilder: TransactionBuilder;
  private submitter: TxSubmitter;
  private routePlanner: RoutePlanner;
  private cache: CacheManager;
  private whaleSignal: WhaleSignal;

  private baseMint: string; // fUSDC mint — we trust this, skip safety on it
  private running = false;

  constructor(opts: {
    connection: Connection;
    ammProgram: any;
    flashProgram: any;
    pools: any;
    tokens: any;
    dirtyTokens: any;
    cache: CacheManager;
    protection: ProtectionManager;
  }) {
    this.connection = opts.connection;
    this.ammProgram = opts.ammProgram;
    this.flashProgram = opts.flashProgram;
    this.pools = opts.pools;
    this.tokens = opts.tokens;
    this.dirtyTokens = opts.dirtyTokens;
    this.cache = opts.cache;
    this.baseMint = opts.tokens.tokenA.mint; // fUSDC

    this.arbDetector = new ArbitrageDetector(opts.connection);
    this.safety = new SafetyPipeline(opts.connection, opts.cache);
    this.router = new OpportunityRouter();
    this.protection = opts.protection;
    this.routePlanner = new RoutePlanner(opts.pools);
    this.txBuilder = new TransactionBuilder(
      opts.connection, opts.ammProgram, opts.protection.slippage, opts.tokens,
    );
    this.submitter = new TxSubmitter(this.txBuilder, opts.protection);

    const whaleCache = new WhaleCache(opts.cache);
    this.whaleSignal = new WhaleSignal(whaleCache);

    logger.info("Trading engine initialized");
  }

  // ── Resolve mint address for a token name ──────────────

  private resolveMint(tokenName: string): string {
    // Check clean tokens
    for (const key of Object.keys(this.tokens)) {
      if (this.tokens[key].name === tokenName) return this.tokens[key].mint;
    }
    // Check dirty tokens
    for (const key of Object.keys(this.dirtyTokens)) {
      const entry = this.dirtyTokens[key];
      if (entry.mint && tokenName.toLowerCase().includes(key.split("_")[0]!)) {
        return entry.mint;
      }
    }
    return "";
  }

  // ── Get mints for a pool ───────────────────────────────

  private getPoolMints(pool: any): { mintA: string; mintB: string } {
    if (pool.tokenAMint && pool.tokenBMint) {
      return { mintA: pool.tokenAMint, mintB: pool.tokenBMint };
    }
    return {
      mintA: this.resolveMint(pool.tokenA),
      mintB: this.resolveMint(pool.tokenB),
    };
  }

  // ── Phase A: Discover ──────────────────────────────────

  private async discover(): Promise<{
    poolsScanned: number;
    opportunities: DiscoveredOpportunity[];
    poolStates: Map<string, PoolState>;
  }> {
    logger.info("═══ Phase A: DISCOVER ═══");

    const poolEntries = Object.entries(this.pools) as [string, any][];
    logger.info(`Scanning ${poolEntries.length} pools...`);

    const poolStates = new Map<string, PoolState>();
    const validPools: { key: string; pool: any; state: PoolState }[] = [];

    // Scan ALL pools
    for (const [key, pool] of poolEntries) {
      try {
        const state = await this.arbDetector.getPoolState(pool);
        poolStates.set(key, state);
        validPools.push({ key, pool, state });
        logger.info({
          pool: pool.name,
          reserveA: state.reserveA.toFixed(2),
          reserveB: state.reserveB.toFixed(2),
        }, `  Pool ${key}`);
      } catch (e: any) {
        logger.warn({ pool: key, error: e.message }, "  Pool read failed — skipping");
      }
    }

    // Collect ALL opportunities
    const opportunities: DiscoveredOpportunity[] = [];
    const cfg = getConfig();
    const borrowAmount = Math.min(100, cfg.capital.flash_loan_max_usd);

    // Check triangular arbs across clean pool triplet (pool1, pool2, pool3)
    const p1 = poolStates.get("pool1");
    const p2 = poolStates.get("pool2");
    const p3 = poolStates.get("pool3");

    if (p1 && p2 && p3) {
      const triArbs = await this.arbDetector.scan(this.pools, [borrowAmount]);
      for (const arb of triArbs) {
        // Collect all non-base mints involved
        const mints = new Set<string>();
        mints.add(this.tokens.tokenB.mint); // fSOL
        mints.add(this.tokens.tokenC.mint); // fRAY

        opportunities.push({
          arb,
          poolStates: [p1, p2, p3],
          involvedMints: Array.from(mints),
          poolKeys: ["pool1", "pool2", "pool3"],
          isTriangular: true,
        });
      }
    }

    // Check each non-triangular pool for potential arb (e.g., dirty pools)
    for (const { key, pool, state } of validPools) {
      if (["pool1", "pool2", "pool3"].includes(key)) continue; // already checked in triangular

      const mints = this.getPoolMints(pool);
      const nonBaseMints: string[] = [];
      if (mints.mintA && mints.mintA !== this.baseMint) nonBaseMints.push(mints.mintA);
      if (mints.mintB && mints.mintB !== this.baseMint) nonBaseMints.push(mints.mintB);

      // Create a potential arb for this pool
      const syntheticArb: ArbOpportunity = {
        type: "arbitrage",
        path: `${key} (${pool.name})`,
        tokenIn: pool.tokenA,
        tokenOut: pool.tokenB,
        amountIn: borrowAmount,
        expectedProfit: 0,
        profitPercent: 0,
        pools: [state],
        timestamp: Date.now(),
      };

      opportunities.push({
        arb: syntheticArb,
        poolStates: [state],
        involvedMints: nonBaseMints,
        poolKeys: [key],
        isTriangular: false,
      });
    }

    logger.info(`Found ${opportunities.length} opportunities across all pools`);

    return {
      poolsScanned: validPools.length,
      opportunities,
      poolStates,
    };
  }

  // ── Phase B: Execute ───────────────────────────────────

  private async execute(
    opportunities: DiscoveredOpportunity[],
    poolStates: Map<string, PoolState>,
  ): Promise<TickDetail[]> {
    logger.info("═══ Phase B: EXECUTE (priority: FIFO) ═══");

    const details: TickDetail[] = [];

    for (let i = 0; i < opportunities.length; i++) {
      const opp = opportunities[i]!;
      const label = `Opportunity ${i + 1}/${opportunities.length}: ${opp.arb.path}`;
      logger.info(`\n${label}`);

      // ── Step 1: Safety check on all involved mints ──
      let safePassed = true;
      let safetyFailReason = "";

      for (const mint of opp.involvedMints) {
        const poolAddr = opp.poolStates[0]?.address;
        const result = await this.safety.check(mint, poolAddr);
        if (!result.passed) {
          safePassed = false;
          safetyFailReason = `${mint.slice(0, 8)}... failed at ${result.failedAt}` +
            (result.s1.failReason ? ` — "${result.s1.failReason}"` : "");
          logger.info(`  → Safety: ${safetyFailReason}`);
          break;
        }
        logger.info(`  → Safety: ${mint.slice(0, 8)}... PASSED`);
      }

      if (!safePassed) {
        logger.info("  → SKIPPED");
        details.push({
          pool: opp.poolKeys.join("+"),
          opportunity: opp.arb.path,
          stage: "safety_rejected",
          reason: safetyFailReason,
        });
        continue;
      }

      // ── Whale signal (log-only, non-blocking) ──
      for (const mint of opp.involvedMints) {
        try {
          const ws = await this.whaleSignal.getSignal(mint);
          if (ws.netDirection !== "unknown") {
            logger.info({
              token: mint.slice(0, 8) + "...",
              direction: ws.netDirection,
              accumulating: ws.accumulatingCount,
              distributing: ws.distributingCount,
              confidence: ws.avgConfidence,
            }, "  → Whale signal");
          }
        } catch (e: any) {
          logger.debug({ mint: mint.slice(0, 8), error: e.message }, "Whale signal lookup failed");
        }
      }

      // ── Step 2: Route ──
      const routed = this.router.route(opp.arb);
      logger.info(`  → Router: ${routed.path.toUpperCase()} — "${routed.reason}"`);

      // ── Step 3: Slow path → queue for later ──
      if (routed.path === "slow") {
        logger.info("  → QUEUED for AI confirmation (Phase 8)");
        details.push({
          pool: opp.poolKeys.join("+"),
          opportunity: opp.arb.path,
          stage: "slow_queued",
          reason: "Slow path — needs AI confirmation",
        });
        continue;
      }

      // ── Step 4: Protection guard ──
      const gate = this.protection.canExecuteTrade(0); // fast path = 0 capital
      if (!gate.allowed) {
        logger.info(`  → Guard: BLOCKED — "${gate.reason}"`);
        details.push({
          pool: opp.poolKeys.join("+"),
          opportunity: opp.arb.path,
          stage: "guard_rejected",
          reason: gate.reason ?? "blocked by protection",
        });
        continue;
      }
      logger.info("  → Guard: PASSED");

      // ── Step 5: Execute ──
      if (opp.isTriangular) {
        const execResult = await this.executeTriangularArb(opp, poolStates);
        details.push(execResult);
      } else {
        logger.info("  → Non-triangular pool arb — not yet implemented");
        details.push({
          pool: opp.poolKeys.join("+"),
          opportunity: opp.arb.path,
          stage: "failed",
          reason: "Non-triangular arb not implemented yet",
        });
      }
    }

    return details;
  }

  // ── Execute a triangular arb via flash loan ────────────

  private async executeTriangularArb(
    opp: DiscoveredOpportunity,
    poolStates: Map<string, PoolState>,
  ): Promise<TickDetail> {
    const cfg = getConfig();
    const borrowAmount = Math.min(opp.arb.amountIn, cfg.capital.flash_loan_max_usd);

    let flashVaultConfig: any;
    try {
      flashVaultConfig = JSON.parse(fs.readFileSync("config/devnet_flash_vault.json", "utf-8"));
    } catch {
      return {
        pool: opp.poolKeys.join("+"),
        opportunity: opp.arb.path,
        stage: "failed",
        reason: "Flash vault config missing — run: npx ts-node scripts/devnet/setup_flash_vault.ts",
      };
    }

    const p1 = poolStates.get("pool1")!;
    const p2 = poolStates.get("pool2")!;
    const p3 = poolStates.get("pool3")!;

    const feeNum = cfg.amm.fee_numerator;
    const feeDen = cfg.amm.fee_denominator;
    const calcOut = (amt: number, resIn: number, resOut: number) =>
      (amt * feeNum * resOut) / (resIn * feeDen + amt * feeNum);

    // Determine direction from the arb path
    const isReverse = opp.arb.path.includes("reverse") ||
      opp.arb.path.startsWith(this.pools.pool3?.name);

    let step1Out: number, step2Out: number, step3Out: number;

    if (isReverse) {
      step1Out = calcOut(borrowAmount, p3.reserveA, p3.reserveB);
      step2Out = calcOut(step1Out, p2.reserveB, p2.reserveA);
      step3Out = calcOut(step2Out, p1.reserveB, p1.reserveA);
    } else {
      step1Out = calcOut(borrowAmount, p1.reserveA, p1.reserveB);
      step2Out = calcOut(step1Out, p2.reserveA, p2.reserveB);
      step3Out = calcOut(step2Out, p3.reserveB, p3.reserveA);
    }

    const profit = step3Out - borrowAmount;

    logger.info({
      borrow: `${borrowAmount} fUSDC`,
      step1: step1Out.toFixed(4),
      step2: step2Out.toFixed(6),
      step3: step3Out.toFixed(4),
      profit: `+${profit.toFixed(4)} fUSDC`,
    }, "  → Arb calculation");

    if (profit <= 0) {
      return {
        pool: opp.poolKeys.join("+"),
        opportunity: opp.arb.path,
        stage: "failed",
        reason: "Not profitable after fees",
      };
    }

    const route = this.routePlanner.planTriangularArb(
      borrowAmount, step1Out, step2Out, step3Out, isReverse,
    );

    const flashTx = await this.txBuilder.buildFlashLoanArbTransaction(
      route, this.pools, this.flashProgram,
      flashVaultConfig.flashConfig, flashVaultConfig.vault,
      borrowAmount, this.tokens.tokenA.decimals,
    );

    const balBefore = await this.connection.getTokenAccountBalance(
      new PublicKey(this.tokens.tokenA.account),
    );

    const execResult = await this.submitter.submit(flashTx, 0, "fast");

    if (execResult.success) {
      const balAfter = await this.connection.getTokenAccountBalance(
        new PublicKey(this.tokens.tokenA.account),
      );
      const realProfit = parseFloat(balAfter.value.uiAmountString!) -
        parseFloat(balBefore.value.uiAmountString!);

      logger.info(`  → EXECUTED  profit=+${realProfit.toFixed(4)} fUSDC  tx=${execResult.signature?.slice(0, 16)}...`);

      return {
        pool: opp.poolKeys.join("+"),
        opportunity: opp.arb.path,
        stage: "executed",
        profit: realProfit,
        signature: execResult.signature ?? "",
      };
    } else {
      logger.info(`  → FAILED: ${execResult.reason}`);
      return {
        pool: opp.poolKeys.join("+"),
        opportunity: opp.arb.path,
        stage: "failed",
        reason: execResult.reason ?? "unknown error",
      };
    }
  }

  // ── Public: Create arb-inducing price gap (devnet testing) ──

  async createPriceGap(): Promise<void> {
    logger.info("Creating price gap on pool1 for testing...");
    const wallet = loadWallet();
    await this.ammProgram.methods
      .swap(new BN(5000 * 10 ** this.tokens.tokenA.decimals), new BN(1), true)
      .accounts({
        pool: new PublicKey(this.pools.pool1.address),
        tokenAVault: new PublicKey(this.pools.pool1.tokenAVault),
        tokenBVault: new PublicKey(this.pools.pool1.tokenBVault),
        userTokenA: new PublicKey(this.tokens.tokenA.account),
        userTokenB: new PublicKey(this.tokens.tokenB.account),
        user: wallet.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
    logger.info("Price gap created");
  }

  // ── Public: tick() ─────────────────────────────────────

  async tick(): Promise<TickResult> {
    logger.info("\n" + "=".repeat(60));
    logger.info("  TICK — Trading Engine");
    logger.info("=".repeat(60));

    // Phase A: Discover
    const { poolsScanned, opportunities, poolStates } = await this.discover();

    if (opportunities.length === 0) {
      logger.info("No opportunities — tick complete");
      return {
        poolsScanned,
        opportunitiesFound: 0,
        safetyRejected: 0,
        guardRejected: 0,
        tradesExecuted: 0,
        tradesFailed: 0,
        details: [],
      };
    }

    // Phase B: Execute in priority order (FIFO for now)
    const details = await this.execute(opportunities, poolStates);

    // Summary
    const safetyRejected = details.filter(d => d.stage === "safety_rejected").length;
    const guardRejected = details.filter(d => d.stage === "guard_rejected").length;
    const tradesExecuted = details.filter(d => d.stage === "executed").length;
    const tradesFailed = details.filter(d => d.stage === "failed").length;

    logger.info("\n=== Summary ===");
    logger.info(`  Pools scanned: ${poolsScanned} | Opportunities: ${opportunities.length} | ` +
      `Rejected: ${safetyRejected} | Guards: ${guardRejected} | Executed: ${tradesExecuted} | Failed: ${tradesFailed}`);
    logger.info(this.protection.getStatus(), "Protection state");

    return {
      poolsScanned,
      opportunitiesFound: opportunities.length,
      safetyRejected,
      guardRejected,
      tradesExecuted,
      tradesFailed,
      details,
    };
  }

  // ── Loop control ───────────────────────────────────────

  async startLoop(intervalMs: number = 5000): Promise<void> {
    this.running = true;
    logger.info({ intervalMs }, "Trading engine loop started");

    while (this.running) {
      try {
        await this.tick();
      } catch (e: any) {
        logger.error({ error: e.message }, "Tick failed");
      }
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }

    logger.info("Trading engine loop stopped");
  }

  stop(): void {
    this.running = false;
    logger.info("Trading engine stopping...");
  }

  getProtectionStatus() {
    return this.protection.getStatus();
  }
}
