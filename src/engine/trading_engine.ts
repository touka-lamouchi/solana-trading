/**
 * TradingEngine — The bot brain.
 *
 * Each tick():
 *   Phase A: Scan ALL pools → collect ALL opportunities
 *   Phase B: Process each opportunity in priority order:
 *            safety → route → guard → execute
 */

import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";

import { ArbitrageDetector, ArbOpportunity, PoolState } from "../layer1_opportunity/pure_code/arbitrage_detector";
import { PoolMonitor } from "../infrastructure/pool_monitor";
import { ArbReactor, DiscoveredOpportunity } from "./arb_reactor";
import { LiquidationReactor } from "./liquidation_reactor";
import { CandleReactor, ClosedCandle } from "../infrastructure/candle_reactor";
import { YieldRateMonitor } from "../layer1_opportunity/pure_code/yield_rate_monitor";
import { LiquidationHunter } from "../layer1_opportunity/pure_code/liquidation_hunter";
import { ChartPatternDetector } from "../layer1_opportunity/ai_signals/chart_pattern_detector";
import { SocialBuzzDetector } from "../layer1_opportunity/ai_signals/social_buzz_detector";
import { WhaleCopyDetector } from "../layer1_opportunity/ai_signals/whale_copy_detector";
import { MempoolMonitor } from "../infrastructure/mempool_monitor";
import { MempoolSignal } from "../layer1_opportunity/ai_signals/mempool_signal";
import { MempoolPressureDetector } from "../layer1_opportunity/ai_signals/mempool_pressure_detector";
import { NewsFeedMonitor } from "../infrastructure/news_feeds";
import { NewsSignal } from "../layer1_opportunity/ai_signals/news_signal";
import { SafetyPipeline } from "../layer1_opportunity/safety_filters/safety_pipeline";
import { OpportunityRouter } from "../layer1_opportunity/opportunity_router";
import { ProtectionManager } from "../protection/protection_manager";
import { TransactionBuilder } from "../layer2_execution/transaction_builder";
import { TxSubmitter } from "../layer3_protection/tx_submitter";
import { RoutePlanner } from "../layer2_execution/route_planner";
import { VolatilityPredictor } from "../layer2_execution/volatility_predictor";
import { CacheManager } from "../cache/cache_manager";
import { WhaleCache } from "../cache/whale_cache";
import { LSTMCache } from "../cache/lstm_cache";
import { SentimentCache } from "../cache/sentiment_cache";
import { WhaleSignal } from "../layer1_opportunity/ai_signals/whale_signal";
import { LSTMSignal } from "../layer1_opportunity/ai_signals/lstm_signal";
import { SentimentSignal } from "../layer1_opportunity/ai_signals/sentiment_signal";
import { DecisionModel, DecisionResult, AIWeights } from "../layer1_opportunity/decision_model";
import { ModelServer } from "../models/model_server";
import { IngestionService } from "../ingestion/ingestion_service";
import { PoolState as CandlePoolState } from "../ingestion/candle_fetcher";
import { getConfig } from "../utils/config";
import { logger } from "../utils/logger";
import { LendingClient } from "../layer2_execution/lending_client";
import fs from "fs";

// ── Types ────────────────────────────────────────────────

export interface TickDetail {
  pool: string;
  opportunity: string;
  stage: "safety_rejected" | "guard_rejected" | "slow_queued" | "executed" | "failed";
  reason?: string;
  profit?: number;
  signature?: string;
  oppType?: string;  // e.g. "arbitrage" | "yield" | "directional" | "social_buzz" | etc.
}

export interface PoolSnapshot {
  key: string;
  name: string;
  tokenA: string;
  tokenB: string;
  reserveA: number;
  reserveB: number;
  price: number;            // tokenA per tokenB
  priceInverse: number;     // tokenB per tokenA
  tvl: number;              // total value locked in tokenA terms
}

export interface OpportunitySnapshot {
  type:
    | "arbitrage"
    | "yield"
    | "liquidation"
    | "directional"
    | "chart_pattern"
    | "social_buzz"
    | "copy_whale"
    | "mempool_pressure";
  path: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: number;
  estimatedProfit: number;
  profitPercent: number;
  pools: string[];           // pool keys involved
  timestamp: number;
  signalSource?: string;
}

export interface MarketSnapshot {
  pools: PoolSnapshot[];
  opportunities: OpportunitySnapshot[];
  timestamp: number;
}

export interface TickResult {
  poolsScanned: number;
  opportunitiesFound: number;
  safetyRejected: number;
  guardRejected: number;
  tradesExecuted: number;
  tradesFailed: number;
  details: TickDetail[];
  market?: MarketSnapshot;   // populated in viewer mode and for status
  vault?: { balance: number; isActive: boolean; totalDeposits?: number; totalWithdrawals?: number; profit?: number } | null;
}

// DiscoveredOpportunity is now exported from arb_reactor.ts and re-exported here
// so callers that import it from trading_engine.ts keep working.
export type { DiscoveredOpportunity } from "./arb_reactor";

// ── Engine ───────────────────────────────────────────────

export class TradingEngine {
  private connection: Connection;
  private ammProgram: any;
  private flashProgram: any;
  private pools: any;
  private tokens: any;
  private dirtyTokens: any;

  private arbDetector: ArbitrageDetector;
  private yieldMonitor: YieldRateMonitor;
  private liquidationHunter: LiquidationHunter;
  private chartPatternDetector: ChartPatternDetector;
  private sentimentSignal: SentimentSignal;
  private socialBuzzDetector: SocialBuzzDetector;
  private whaleCopyDetector: WhaleCopyDetector;
  private mempoolMonitor: MempoolMonitor;
  private mempoolSignal: MempoolSignal;
  private mempoolPressureDetector: MempoolPressureDetector;
  private newsFeedMonitor: NewsFeedMonitor | null = null;
  private newsSignal: NewsSignal;
  private safety: SafetyPipeline;
  private router: OpportunityRouter;
  private protection: ProtectionManager;
  private txBuilder: TransactionBuilder;
  private submitter: TxSubmitter;
  private routePlanner: RoutePlanner;
  private cache: CacheManager;
  private whaleSignal: WhaleSignal;
  private decisionModel: DecisionModel;
  private ingestionService: IngestionService;
  private modelServer: ModelServer;
  private lastDecision: DecisionResult | null = null;

  private userKeypair: Keypair;
  private baseMint: string; // fUSDC mint — we trust this, skip safety on it
  private running = false;

  // ── Event-driven reactors (attached via attachPoolMonitor) ──────
  private poolMonitor: PoolMonitor | null = null;
  private arbReactor: ArbReactor | null = null;
  private liquidationReactor: LiquidationReactor | null = null;
  private candleReactor: CandleReactor | null = null;

  // Lending client — lazily initialized from config/devnet_lending.json.
  private lendingClient: LendingClient | null = null;

  // Called by UserRegistry for every TickDetail produced by fast/slow handlers.
  // Lets the registry broadcast to WebSocket without depending on tick().
  public onDetail?: (detail: TickDetail) => void;

  // Reactor-detected opportunities since the last scan_complete broadcast.
  // runLoop reads + resets these so the unified scan_complete event reflects
  // both polling-loop discoveries AND event-driven reactor discoveries.
  private reactorOppsFound = 0;
  private reactorPoolEvents = 0;
  consumeReactorCounters(): { opportunities: number; poolEvents: number } {
    const out = { opportunities: this.reactorOppsFound, poolEvents: this.reactorPoolEvents };
    this.reactorOppsFound = 0;
    this.reactorPoolEvents = 0;
    return out;
  }
  noteReactorOpportunity(): void { this.reactorOppsFound++; }
  noteReactorPoolEvent(): void { this.reactorPoolEvents++; }

  private userConfig: {
    flashLoans?: boolean;
    yieldGaps?: boolean;
    liquidations?: boolean;
    chartPatterns?: boolean;
    socialBuzz?: boolean;
    copyWhales?: boolean;
    mode?: "active" | "viewer";
    aiWeights?: { chart: number; social: number; whale: number };
    aiConfidenceThreshold?: number;
  } | null = null;

  constructor(opts: {
    connection: Connection;
    ammProgram: any;
    flashProgram: any;
    pools: any;
    tokens: any;
    dirtyTokens: any;
    cache: CacheManager;
    protection: ProtectionManager;
    userKeypair: Keypair;
  }) {
    this.connection = opts.connection;
    this.ammProgram = opts.ammProgram;
    this.flashProgram = opts.flashProgram;
    this.pools = opts.pools;
    this.tokens = opts.tokens;
    this.dirtyTokens = opts.dirtyTokens;
    this.cache = opts.cache;
    this.userKeypair = opts.userKeypair;
    this.baseMint = opts.tokens.tokenA.mint; // fUSDC

    this.arbDetector = new ArbitrageDetector(opts.connection);

    // Yield rate monitor — no seeds. On devnet there's no live yield protocol
    // to read from, so this returns no opportunities until a real Raydium/Orca
    // API reader is wired (mainnet path).
    this.yieldMonitor = new YieldRateMonitor();

    // Liquidation hunter — reads real loan positions from a Redis registry
    // (populated by scripts/devnet/trigger/create_loan.ts) and computes health each
    // tick from live pool reserves. When pool prices shift (e.g., after a
    // real arb), positions can cross their threshold and become liquidatable.
    this.liquidationHunter = new LiquidationHunter();
    this.liquidationHunter.setCache(opts.cache);

    // Chart pattern detector — predictive AI-driven detector. Reads the last
    // DecisionModel output (regime + volLevel + direction + aiScore) and
    // emits a "chart_pattern" opportunity when conditions converge.
    this.chartPatternDetector = new ChartPatternDetector({
      aiScoreThreshold: 0.5,
      requiredRegime: "trending",
      requiredVolLevel: "high",
    });

    this.safety = new SafetyPipeline(opts.connection, opts.cache);
    this.router = new OpportunityRouter();
    this.protection = opts.protection;
    this.routePlanner = new RoutePlanner(opts.pools);
    this.txBuilder = new TransactionBuilder(
      opts.connection, opts.ammProgram, opts.protection.slippage, opts.tokens, opts.userKeypair,
    );
    this.submitter = new TxSubmitter(this.txBuilder, opts.protection);

    const whaleCache = new WhaleCache(opts.cache);
    this.whaleSignal = new WhaleSignal(whaleCache);

    // AI signal pipeline: ModelServer → Signals → DecisionModel
    const cfg = getConfig();
    this.modelServer = new ModelServer(
      cfg.ai_server?.host ?? "localhost",
      cfg.ai_server?.port ?? 8000,
    );
    const lstmCache = new LSTMCache(opts.cache);
    const sentimentCache = new SentimentCache(opts.cache);
    const lstmSignal = new LSTMSignal(this.modelServer, lstmCache);
    this.sentimentSignal = new SentimentSignal(this.modelServer, sentimentCache);
    const volatilityPredictor = new VolatilityPredictor(this.modelServer);

    // Mempool monitor:
    //   - mainnet mode → subscribe to mainnet RPC + Raydium V4 / Orca Whirlpool
    //     program logs, track wSOL flow. Real mempool pressure on real volume.
    //   - devnet mode → subscribe to local connection + project AMM, track
    //     local fSOL/fRAY (almost zero data unless other devnet bots are active).
    const cfgEarly = getConfig();
    const mainnetMode = cfgEarly.ai?.data_source === "mainnet";
    const RAYDIUM_V4 = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
    const ORCA_WHIRLPOOL = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
    const mempoolConnection = mainnetMode
      ? new Connection(
          cfgEarly.network?.mainnet_rpc_url ?? "https://api.mainnet-beta.solana.com",
          { commitment: "confirmed" },
        )
      : opts.connection;
    const mempoolMints = mainnetMode && cfgEarly.ai?.target_mint_mainnet
      ? [cfgEarly.ai.target_mint_mainnet]
      : [opts.tokens.tokenB.mint, opts.tokens.tokenC.mint];
    const mempoolPrograms = mainnetMode ? [RAYDIUM_V4, ORCA_WHIRLPOOL] : undefined;

    this.mempoolMonitor = new MempoolMonitor({
      connection: mempoolConnection,
      cache: opts.cache,
      trackedMints: mempoolMints,
      ...(mempoolPrograms ? { programIds: mempoolPrograms } : {}),
    });
    this.mempoolSignal = new MempoolSignal(this.mempoolMonitor);

    // News feed (RSS + GDELT, no keys required) — feeds the 6th DecisionModel sensor
    const newsSymbol = (cfgEarly.ai?.target_symbol ?? "SOL").toLowerCase();
    const newsCfg = (cfgEarly as any).news ?? {};
    this.newsSignal = new NewsSignal(opts.cache, {
      cryptoWeight: newsCfg.crypto_weight ?? 0.7,
      geoWeight: newsCfg.geo_weight ?? 0.3,
    });

    if (newsCfg.enabled !== false) {
      this.newsFeedMonitor = new NewsFeedMonitor({
        cache: opts.cache,
        aiClient: {
          scoreNews: async (headlines: string[]) => {
            const r = await this.modelServer.predictNewsSentiment(headlines, "crypto");
            if (!r) return null;
            return { score: r.score, magnitude: r.magnitude };
          },
        },
        cryptoSymbol: newsSymbol,
        cryptoPollMs: newsCfg.poll_interval_crypto_ms ?? 60_000,
        geoPollMs: newsCfg.poll_interval_geo_ms ?? 120_000,
        geoKeywords: newsCfg.geo_keywords,
        recencyDecayMin: newsCfg.recency_decay_minutes ?? 60,
      });
    }

    this.decisionModel = new DecisionModel(
      lstmSignal,
      this.sentimentSignal,
      this.whaleSignal,
      volatilityPredictor,
      this.mempoolSignal,
      this.newsSignal,
      newsSymbol,
    );
    this.ingestionService = new IngestionService(opts.cache, this.modelServer);

    // Social buzz detector — reuses the engine's existing sentiment signal
    // so we don't double-fetch Reddit / Gemini per tick (cache is shared).
    this.socialBuzzDetector = new SocialBuzzDetector(this.sentimentSignal, {
      scoreThreshold: 0.7,
      minVolume: 5,
    });

    // Whale copy detector — reuses the engine's existing whale signal
    // (WhaleCache shared with DecisionModel + logWhaleSignals).
    this.whaleCopyDetector = new WhaleCopyDetector(this.whaleSignal, {
      confidenceThreshold: 0.8,
    });

    // Mempool pressure detector — reuses the engine's MempoolSignal
    // (no new monitor instance, no double subscription).
    this.mempoolPressureDetector = new MempoolPressureDetector(this.mempoolSignal, {
      pressureThreshold: 0.5,
      minTxCount: 5,
    });

    logger.info("Trading engine initialized");
  }

  // ── Ingestion init (call after construction) ───────────

  async initIngestion(): Promise<void> {
    await this.ingestionService.init();
  }

  // ── Detector + executor bundle (used by UserRegistry to build EngineDeps) ──
  // Single accessor so graph nodes receive individual fields on EngineDeps
  // (testable without a real engine) while avoiding N separate getters.
  exposeDetectors(): {
    arbDetector: ArbitrageDetector;
    yieldMonitor: YieldRateMonitor;
    liquidationHunter: LiquidationHunter;
    chartPatternDetector: ChartPatternDetector;
    socialBuzzDetector: SocialBuzzDetector;
    whaleCopyDetector: WhaleCopyDetector;
    mempoolPressureDetector: MempoolPressureDetector;
    decisionModel: DecisionModel;
    ingestionService: IngestionService;
    poolMonitor: PoolMonitor | null;
    safety: SafetyPipeline;
    router: OpportunityRouter;
  } {
    return {
      arbDetector: this.arbDetector,
      yieldMonitor: this.yieldMonitor,
      liquidationHunter: this.liquidationHunter,
      chartPatternDetector: this.chartPatternDetector,
      socialBuzzDetector: this.socialBuzzDetector,
      whaleCopyDetector: this.whaleCopyDetector,
      mempoolPressureDetector: this.mempoolPressureDetector,
      decisionModel: this.decisionModel,
      ingestionService: this.ingestionService,
      poolMonitor: this.poolMonitor,
      safety: this.safety,
      router: this.router,
    };
  }

  // ── Public execution methods (called by graph execution nodes) ────────
  // Previously private — exposed so the graph's execute_fast / execute_slow
  // nodes can invoke them directly without going through tick().
  async executeTriangularArbPublic(
    opp: DiscoveredOpportunity,
    poolStates: Map<string, PoolState>,
  ): Promise<TickDetail> {
    return this.executeTriangularArb(opp, poolStates);
  }

  async executeDirectionalTradePublic(
    opp: DiscoveredOpportunity,
    poolStates: Map<string, PoolState>,
  ): Promise<TickDetail> {
    return this.executeDirectionalTrade(opp, poolStates);
  }

  async executeLiquidationPublic(
    opp: DiscoveredOpportunity,
    poolStates: Map<string, PoolState>,
  ): Promise<TickDetail> {
    return this.executeLiquidation(opp, poolStates);
  }

  async logWhaleSignalsPublic(mints: string[]): Promise<void> {
    return this.logWhaleSignals(mints);
  }

  // ── Attach event-driven pool monitor ──────────────────
  // Call this before startLoop(). When attached, startLoop() subscribes
  // to pool vault accounts and replaces poll-based arb/liquidation
  // detection with immediate per-change reactions.
  attachPoolMonitor(monitor: PoolMonitor): void {
    this.poolMonitor = monitor;
    // Count every pool change so the unified scan_complete event can show
    // "saw N pool events since last scan" — proves the event-driven path is alive.
    monitor.on("change", () => { this.reactorPoolEvents++; });
  }

  // ── Public fast-path handler (called by ArbReactor / LiquidationReactor) ──
  // Runs guard + vault check + execution for a single fast-path opportunity.
  async handleFastOpportunity(
    opp: DiscoveredOpportunity,
    poolStates: Map<string, PoolState>,
  ): Promise<void> {
    if (this.userConfig?.mode === "viewer") return;

    this.reactorOppsFound++;
    logger.info(`[Event] Fast opportunity: ${opp.arb.path}`);

    await this.logWhaleSignals(opp.involvedMints);

    const gate = this.protection.canExecuteTrade(0);
    if (!gate.allowed) {
      logger.info(`  → Guard: BLOCKED — "${gate.reason}"`);
      return;
    }
    logger.info("  → Guard: PASSED");

    const vaultReader = this.protection.getVaultReader();
    if (vaultReader) {
      try {
        const vs = await vaultReader.getState();
        if (!vs.exists) { logger.info("  → Vault: BLOCKED — not created"); return; }
        if (!vs.isActive) { logger.info("  → Vault: BLOCKED — paused"); return; }
        if (vs.balance <= 0) { logger.info("  → Vault: BLOCKED — empty"); return; }
        logger.info(`  → Vault: PASSED (balance: ${vs.balance.toFixed(2)})`);
      } catch (e: any) {
        logger.warn({ error: e.message }, "  → Vault read failed — allowing trade");
      }
    }

    if (opp.isTriangular) {
      const d = await this.executeTriangularArb(opp, poolStates);
      d.oppType = opp.arb.type;
      logger.info({ stage: d.stage, profit: d.profit, sig: d.signature?.slice(0, 16) }, "[Event] Fast result");
      this.onDetail?.(d);
    } else {
      logger.info({ type: opp.arb.type }, "[Event] Fast path: liquidation detected (no lending protocol wired yet)");
    }
  }

  // ── Public slow-path handler (called by CandleReactor / slowTick) ─
  // Runs AI threshold + S1-S4 safety + protection guard + directional execution.
  async handleSlowOpportunity(
    opp: DiscoveredOpportunity,
    poolStates: Map<string, PoolState>,
  ): Promise<void> {
    if (this.userConfig?.mode === "viewer") return;

    this.reactorOppsFound++;
    const aiThreshold = this.userConfig?.aiConfidenceThreshold ?? 0.5;
    if (!this.lastDecision || this.lastDecision.aiScore < aiThreshold) {
      logger.debug(`  → AI score ${this.lastDecision?.aiScore.toFixed(2) ?? "none"} < ${aiThreshold} — skipping`);
      return;
    }

    for (const mint of opp.involvedMints) {
      const poolAddr = opp.poolStates[0]?.address;
      const result = await this.safety.check(mint, poolAddr);
      if (!result.passed) {
        logger.info(`  → Safety: ${mint.slice(0, 8)}… failed at ${result.failedAt}`);
        return;
      }
    }

    await this.logWhaleSignals(opp.involvedMints);

    const effective = await this.protection.getEffectiveCapital(opp.arb.amountIn);
    if (effective.capital < opp.arb.amountIn) {
      logger.info(`  → Capital: BLOCKED — "${effective.reason ?? "capped"}"`);
      return;
    }

    const gate = this.protection.canExecuteTrade(opp.arb.amountIn);
    if (!gate.allowed) {
      logger.info(`  → Guard: BLOCKED — "${gate.reason}"`);
      return;
    }

    const d = await this.executeDirectionalTrade(opp, poolStates);
    d.oppType = opp.arb.type;
    logger.info({ stage: d.stage, profit: d.profit, sig: d.signature?.slice(0, 16) }, "[Event] Slow result");
    this.onDetail?.(d);
  }

  // ── AI decision refresh (called by CandleReactor + slowTick) ─────
  private async refreshAIDecision(): Promise<void> {
    const defaultWeights: AIWeights = { chart: 45, social: 30, whale: 25 };
    const weights = this.userConfig?.aiWeights ?? defaultWeights;
    try {
      const primaryMint: string = this.ingestionService.isMainnetMode()
        ? this.ingestionService.getMainnetMint()
        : this.tokens.tokenB.mint;
      const [regimeFeatures, gruFeatures] = await Promise.all([
        this.ingestionService.getRegimeFeatures(primaryMint),
        this.ingestionService.getGRUFeatures(primaryMint),
      ]);
      this.lastDecision = await this.decisionModel.computeScore(
        primaryMint, weights, "SOL", { regimeFeatures, gruFeatures },
      );
      logger.info({
        aiScore: this.lastDecision.aiScore,
        direction: this.lastDecision.direction,
        regime: this.lastDecision.regime,
      }, "AI decision refreshed");
    } catch (e: any) {
      logger.warn({ error: e.message }, "AI decision refresh failed");
    }
  }

  // ── Candle close handler (CandleReactor callback) ─────────────────
  private async onCandleClosed(_candle: ClosedCandle): Promise<void> {
    // Ingest the latest pool states into the feature window, then refresh.
    const states = this.poolMonitor
      ? this.poolMonitor.getAllStates()
      : new Map<string, PoolState>();

    await this.ingestionService.ingestPoolStates(
      states as unknown as Map<string, import("../ingestion/candle_fetcher").PoolState>,
      (key) => this.mintForPool(key),
    ).catch(() => {});

    await this.refreshAIDecision();

    if (!this.lastDecision) return;

    const aiThreshold = this.userConfig?.aiConfidenceThreshold ?? 0.5;
    if (
      this.lastDecision.direction !== "neutral" &&
      this.lastDecision.aiScore >= aiThreshold &&
      this.userConfig?.mode !== "viewer"
    ) {
      const p1 = states.get("pool1");
      if (p1) {
        const opp = this.buildDirectionalOpportunity(
          this.lastDecision.direction,
          this.lastDecision.aiScore,
          p1,
        );
        await this.handleSlowOpportunity(opp, states);
      }
    }
  }

  // ── Slow tick (signal-based opportunities, 5s interval) ───────────
  // Handles chart, social, whale, mempool, yield detectors.
  // Arb and liquidation are handled by event-driven reactors instead.
  private async slowTick(): Promise<void> {
    const states: Map<string, PoolState> = this.poolMonitor
      ? this.poolMonitor.getAllStates()
      : await this.readPoolStatesFromRpc();

    const p1 = states.get("pool1");
    if (!p1) return;

    // If no candle reactor is running, refresh AI decision here (fallback).
    if (!this.candleReactor) {
      await this.ingestionService.ingestPoolStates(
        states as unknown as Map<string, import("../ingestion/candle_fetcher").PoolState>,
        (key) => this.mintForPool(key),
      ).catch(() => {});
      await this.refreshAIDecision();
    }
  }

  // RPC fallback when no PoolMonitor is attached.
  private async readPoolStatesFromRpc(): Promise<Map<string, PoolState>> {
    const map = new Map<string, PoolState>();
    for (const [key, pool] of Object.entries(this.pools) as [string, any][]) {
      try {
        map.set(key, await this.arbDetector.getPoolState(pool));
      } catch { /* skip */ }
    }
    return map;
  }

  // Find the first valid pool that contains the given token name (tokenA or tokenB).
  // Used by yield routing to pick a concrete venue for each yield gap.
  private findPoolWithToken(
    tokenName: string,
    validPools: { key: string; pool: any; state: PoolState }[],
  ): { key: string; pool: any; state: PoolState } | null {
    for (const vp of validPools) {
      if (vp.pool.tokenA === tokenName || vp.pool.tokenB === tokenName) return vp;
    }
    return null;
  }

  // Returns the non-base-token mint for a given pool key (the token we want to track).
  private mintForPool(poolKey: string): string {
    const pool = this.pools[poolKey];
    if (!pool) return "";
    const { mintA, mintB } = this.getPoolMints(pool);
    // Track the non-USDC side; prefer mintB (e.g. fSOL, fRAY)
    if (mintB && mintB !== this.baseMint) return mintB;
    if (mintA && mintA !== this.baseMint) return mintA;
    return "";
  }

  // ── User config for opportunity filtering ───────────────

  setUserConfig(config: {
    flashLoans?: boolean;
    yieldGaps?: boolean;
    liquidations?: boolean;
    chartPatterns?: boolean;
    socialBuzz?: boolean;
    copyWhales?: boolean;
    mode?: "active" | "viewer";
    aiWeights?: { chart: number; social: number; whale: number };
    aiConfidenceThreshold?: number;
  }): void {
    this.userConfig = config;
    logger.info({
      mode: config.mode ?? "active",
      flashLoans: config.flashLoans,
      yieldGaps: config.yieldGaps,
      liquidations: config.liquidations,
      aiWeights: config.aiWeights,
      aiThreshold: config.aiConfidenceThreshold,
    }, "Engine user config updated");
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

    if (this.poolMonitor?.isRunning()) {
      // Fast path: use in-memory states from PoolMonitor — zero RPC calls.
      for (const [key] of poolEntries) {
        const state = this.poolMonitor.getState(key);
        if (state) {
          poolStates.set(key, state);
          validPools.push({ key, pool: this.pools[key], state });
        }
      }
    } else {
      // Legacy path: read each pool vault from RPC.
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
    }

    // Collect ALL opportunities
    const opportunities: DiscoveredOpportunity[] = [];
    const cfg = getConfig();
    const borrowAmount = Math.min(100, cfg.capital.flash_loan_max_usd);

    // Check triangular arbs across clean pool triplet (pool1, pool2, pool3).
    // Skip when PoolMonitor is attached — ArbReactor handles arb event-driven.
    const p1 = poolStates.get("pool1");
    const p2 = poolStates.get("pool2");
    const p3 = poolStates.get("pool3");

    if (!this.poolMonitor && p1 && p2 && p3) {
      const triArbs = await this.arbDetector.scan(this.pools, [borrowAmount]);
      for (const arb of triArbs) {
        const mints = new Set<string>();
        mints.add(this.tokens.tokenB.mint);
        mints.add(this.tokens.tokenC.mint);
        opportunities.push({
          arb,
          poolStates: [p1, p2, p3],
          involvedMints: Array.from(mints),
          poolKeys: ["pool1", "pool2", "pool3"],
          isTriangular: true,
        });
      }
    }

    logger.info(`Found ${opportunities.length} signal opportunities (arb/liq handled by reactors when event-driven)`);

    // Yield opportunities from the YieldRateMonitor. With no seeded yields
    // (production-real mode), this returns nothing on devnet. Once a live
    // Raydium/Orca/Kamino reader is wired, this fires real gaps.
    const yieldGaps = this.yieldMonitor.scan();

    // Map each YieldOpportunity → ArbOpportunity so it flows through the
    // same execution pipeline (router → slow path → protection → execute).
    for (const gap of yieldGaps) {
      // Pick an existing pool that contains the target token so the slow
      // path has a concrete venue to "deposit" into. On devnet this is
      // just a swap to simulate the act of moving capital to the protocol.
      const poolForToken = this.findPoolWithToken(gap.token, validPools);
      if (!poolForToken) continue;

      const apyDelta = gap.apyDifference;
      // Annualized gap → hourly expected profit proxy (× 1/8760). We scale
      // to tick horizon (~10s) for a rough devnet estimate; treat as signal,
      // not a promise — slow path still gates on AI + protection + vault.
      const capital = Math.min(borrowAmount, 200);
      const expectedProfitUsd = capital * (apyDelta / 100) / 8760; // per-hour

      const yieldOpp: ArbOpportunity = {
        type: "yield",
        path: `yield: ${gap.fromProtocol}@${gap.currentApy.toFixed(2)}% → ${gap.toProtocol}@${gap.targetApy.toFixed(2)}% (${gap.token})`,
        tokenIn: "fUSDC",
        tokenOut: gap.token,
        amountIn: capital,
        expectedProfit: expectedProfitUsd,
        profitPercent: apyDelta,
        pools: [poolForToken.state],
        timestamp: Date.now(),
      };

      const mints = this.getPoolMints(poolForToken.pool);
      const involvedMints: string[] = [];
      if (mints.mintA && mints.mintA !== this.baseMint) involvedMints.push(mints.mintA);
      if (mints.mintB && mints.mintB !== this.baseMint) involvedMints.push(mints.mintB);

      opportunities.push({
        arb: yieldOpp,
        poolStates: [poolForToken.state],
        involvedMints,
        poolKeys: [poolForToken.key],
        isTriangular: false,
      });
    }

    // Liquidation scan — skip when PoolMonitor is attached (LiquidationReactor handles it).
    if (!this.poolMonitor) {
    await this.liquidationHunter.loadFromRedis();
    const priceMap: Record<string, number> = { fUSDC: 1.0 };
    if (p1 && p1.reserveB > 0) priceMap[this.tokens.tokenB.name] = p1.reserveA / p1.reserveB;
    const pool3State = poolStates.get("pool3");
    if (pool3State && pool3State.reserveB > 0) priceMap[this.tokens.tokenC.name] = pool3State.reserveA / pool3State.reserveB;
    this.liquidationHunter.applyPrices(priceMap);
    const liqs = this.liquidationHunter.scan();

    for (const liq of liqs) {
      // Route the liquidation trade through a pool that contains the
      // collateral token so the slow path has a concrete venue to swap into.
      const poolForCollateral = this.findPoolWithToken(liq.collateralToken, validPools);
      if (!poolForCollateral) continue;

      const collateralValue = liq.collateralAmount * (liq.liquidationReward / Math.max(liq.collateralAmount, 0.0001) + liq.debtAmount / Math.max(liq.collateralAmount, 0.0001));
      const capital = Math.min(borrowAmount * 0.5, Math.max(10, liq.liquidationReward));
      const profitPct = liq.liquidationReward / Math.max(capital, 1) * 100;

      const liqOpp: ArbOpportunity = {
        type: "liquidation",
        path: `liquidation: ${liq.borrower.slice(0, 8)}… (${liq.collateralToken}/${liq.debtToken}) health=${liq.healthRatio.toFixed(3)}`,
        tokenIn: "fUSDC",
        tokenOut: liq.collateralToken,
        amountIn: capital,
        expectedProfit: liq.liquidationReward,
        profitPercent: parseFloat(profitPct.toFixed(2)),
        pools: [poolForCollateral.state],
        timestamp: Date.now(),
      };

      const mints = this.getPoolMints(poolForCollateral.pool);
      const involvedMints: string[] = [];
      if (mints.mintA && mints.mintA !== this.baseMint) involvedMints.push(mints.mintA);
      if (mints.mintB && mints.mintB !== this.baseMint) involvedMints.push(mints.mintB);

      opportunities.push({
        arb: liqOpp,
        poolStates: [poolForCollateral.state],
        involvedMints,
        poolKeys: [poolForCollateral.key],
        isTriangular: false,
      });

      // collateralValue is referenced only via path/profit above — kept for clarity
      void collateralValue;
    }
    } // end if (!this.poolMonitor) liquidation block

    // ── Signal/trade bridge ────────────────────────────────────────────
    // When ai.data_source = "mainnet", AI signals (sentiment, whale, mempool,
    // regime) are populated in the cache under the MAINNET mint (e.g., wSOL).
    // The detectors must read from there to see real signals — but the actual
    // *trade* still executes on the devnet pool (fUSDC/fSOL → pool1).
    const aiCfg = getConfig();
    const tradeMint = this.tokens.tokenB.mint;
    const signalMint = (aiCfg.ai?.data_source === "mainnet" && aiCfg.ai?.target_mint_mainnet)
      ? aiCfg.ai.target_mint_mainnet
      : tradeMint;

    // Chart pattern (AI-driven detector). Reads the previous tick's
    // DecisionResult — regime + volLevel + direction + aiScore — and emits
    // a chart_pattern opportunity when conditions converge.
    if (this.lastDecision && p1) {
      const cpCapital = Math.min(borrowAmount, 200);
      const cpOpp = this.chartPatternDetector.scan(
        this.lastDecision, tradeMint, cpCapital, p1, "fUSDC", "fSOL",
      );
      if (cpOpp) {
        opportunities.push({
          arb: cpOpp, poolStates: [p1], involvedMints: [tradeMint],
          poolKeys: ["pool1"], isTriangular: false,
        });
      }
    }

    // Social buzz — uses MAINNET signal mint for cache lookup, trades on devnet pool1.
    if (p1) {
      const sbCapital = Math.min(borrowAmount, 200);
      const sbOpp = await this.socialBuzzDetector.scan({
        tokenMint: signalMint,           // ← mainnet wSOL for real Reddit data
        tokenName: aiCfg.ai?.target_symbol || "SOL",
        capital: sbCapital,
        pool: p1,
        baseTokenName: "fUSDC",
        primaryTokenName: "fSOL",
      });
      if (sbOpp) {
        // Override with devnet trade mint so execution targets pool1 correctly
        sbOpp.tokenIn = sbOpp.tokenIn === "fUSDC" ? "fUSDC" : "fSOL";
        sbOpp.tokenOut = sbOpp.tokenOut === "fUSDC" ? "fUSDC" : "fSOL";
        opportunities.push({
          arb: sbOpp, poolStates: [p1], involvedMints: [tradeMint],
          poolKeys: ["pool1"], isTriangular: false,
        });
      }
    }

    // Copy whales — uses MAINNET signal mint (WhaleTracker writes wSOL whales here).
    if (p1) {
      const wcCapital = Math.min(borrowAmount, 200);
      const wcOpp = await this.whaleCopyDetector.scan({
        tokenMint: signalMint,           // ← mainnet wSOL for real whale data
        capital: wcCapital,
        pool: p1,
        baseTokenName: "fUSDC",
        primaryTokenName: "fSOL",
      });
      if (wcOpp) {
        opportunities.push({
          arb: wcOpp, poolStates: [p1], involvedMints: [tradeMint],
          poolKeys: ["pool1"], isTriangular: false,
        });
      }
    }

    // Mempool pressure — uses MAINNET signal mint (MempoolMonitor tracks wSOL flow).
    if (p1) {
      const mpCapital = Math.min(borrowAmount, 200);
      const mpOpp = await this.mempoolPressureDetector.scan({
        tokenMint: signalMint,           // ← mainnet wSOL for real DEX flow
        capital: mpCapital,
        pool: p1,
        baseTokenName: "fUSDC",
        primaryTokenName: "fSOL",
      });
      if (mpOpp) {
        opportunities.push({
          arb: mpOpp, poolStates: [p1], involvedMints: [tradeMint],
          poolKeys: ["pool1"], isTriangular: false,
        });
      }
    }

    logger.info(`Total opportunities (incl. synthetic): ${opportunities.length}`);

    return {
      poolsScanned: validPools.length,
      opportunities,
      poolStates,
    };
  }

  // ── Phase B: Execute ───────────────────────────────────
  //
  // Per the pipeline architecture:
  //   FAST PATH (arb/liquidation): route → whale log → guard → atomic tx
  //     No S1-S4 — flash loans self-protect (repay failure reverts the whole tx)
  //
  //   SLOW PATH (yield/directional): threshold → S1-S4 → whale log → guard → swap
  //     AI score gates entry; safety validates the token; guard checks capital limits

  private async execute(
    opportunities: DiscoveredOpportunity[],
    poolStates: Map<string, PoolState>,
  ): Promise<TickDetail[]> {
    logger.info("═══ Phase B: EXECUTE (priority: FIFO) ═══");

    const details: TickDetail[] = [];
    const aiThreshold = this.userConfig?.aiConfidenceThreshold ?? 0.5;

    for (let i = 0; i < opportunities.length; i++) {
      const opp = opportunities[i]!;
      logger.info(`\nOpportunity ${i + 1}/${opportunities.length}: ${opp.arb.path}`);

      // ── Step 1: Route first ──
      const routed = this.router.route(opp.arb);
      logger.info(`  → Path: ${routed.path.toUpperCase()} — "${routed.reason}"`);

      if (routed.path === "fast") {
        // ━━━━ FAST PATH ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        // Flash loans are atomic — borrow + swap + repay in one tx.
        // If repay cannot be covered the whole tx reverts, so S1-S4 is
        // not needed here. Only check the protection guard.

        // Whale signal (informational only)
        await this.logWhaleSignals(opp.involvedMints);

        // Protection guard (0 capital = flash loan)
        const gate = this.protection.canExecuteTrade(0);
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

        // Vault gate — even flash-loan arbs require an active, funded vault
        // (it represents the user's authorization for the bot to trade at all).
        const vaultReader = this.protection.getVaultReader();
        if (vaultReader) {
          try {
            const vs = await vaultReader.getState();
            if (!vs.exists) {
              logger.info("  → Vault: BLOCKED — user has not created a vault yet");
              details.push({
                pool: opp.poolKeys.join("+"),
                opportunity: opp.arb.path,
                stage: "guard_rejected",
                reason: "vault not created — call createVault via Phantom",
              });
              continue;
            }
            if (!vs.isActive) {
              logger.info("  → Vault: BLOCKED — paused by owner");
              details.push({
                pool: opp.poolKeys.join("+"),
                opportunity: opp.arb.path,
                stage: "guard_rejected",
                reason: "vault paused by owner",
              });
              continue;
            }
            if (vs.balance <= 0) {
              logger.info("  → Vault: BLOCKED — empty");
              details.push({
                pool: opp.poolKeys.join("+"),
                opportunity: opp.arb.path,
                stage: "guard_rejected",
                reason: "vault empty",
              });
              continue;
            }
            logger.info(`  → Vault: PASSED (balance: ${vs.balance.toFixed(2)})`);
          } catch (e: any) {
            logger.warn({ error: e.message }, "  → Vault read failed — allowing trade");
          }
        }

        // Execute
        if (opp.isTriangular) {
          const d = await this.executeTriangularArb(opp, poolStates);
          d.oppType = opp.arb.type;
          details.push(d);
        } else {
          // Fast path currently only supports real triangular arb (flash-loan
          // backed). Liquidation requires a live lending-protocol integration
          // before it can be executed for real, so until that's wired we drop
          // it rather than fabricate a profit number.
          details.push({
            pool: opp.poolKeys.join("+"),
            opportunity: opp.arb.path,
            stage: "failed",
            reason: opp.arb.type === "liquidation"
              ? "Liquidation: no live lending-protocol reader wired yet"
              : "Fast path: unsupported opportunity type",
            oppType: opp.arb.type,
          });
        }

      } else {
        // ━━━━ SLOW PATH ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        // Uses own capital → verify AI conviction → validate token safety
        // → check protection limits → execute directional swap

        // ── Verification ①: AI threshold ──
        if (!this.lastDecision || this.lastDecision.aiScore < aiThreshold) {
          const score = this.lastDecision?.aiScore.toFixed(2) ?? "none";
          logger.info(`  → AI score ${score} < threshold ${aiThreshold} — DROPPED`);
          details.push({
            pool: opp.poolKeys.join("+"),
            opportunity: opp.arb.path,
            stage: "guard_rejected",
            reason: `AI score ${score} below threshold ${aiThreshold}`,
          });
          continue;
        }
        logger.info(`  → AI score: ${this.lastDecision.aiScore} ≥ ${aiThreshold} — PASSED`);

        // ── Verification ②: S1–S4 safety on all involved mints ──
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
          details.push({
            pool: opp.poolKeys.join("+"),
            opportunity: opp.arb.path,
            stage: "safety_rejected",
            reason: safetyFailReason,
          });
          continue;
        }

        // Whale signal (informational only)
        await this.logWhaleSignals(opp.involvedMints);

        // ── Verification ③: Protection guard (with capital) ──
        const capitalRequired = opp.arb.amountIn;

        // Vault + drawdown effective cap
        const effective = await this.protection.getEffectiveCapital(capitalRequired);
        if (effective.capital < capitalRequired) {
          const reason = effective.reason ?? `capped to ${effective.capital.toFixed(2)}`;
          logger.info(`  → Vault/Drawdown: BLOCKED — "${reason}"`);
          details.push({
            pool: opp.poolKeys.join("+"),
            opportunity: opp.arb.path,
            stage: "guard_rejected",
            reason,
          });
          continue;
        }

        const gate = this.protection.canExecuteTrade(capitalRequired);
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
        logger.info(`  → Guard: PASSED (capital: $${capitalRequired.toFixed(2)})`);

        // ── Execute slow path ──
        const slowTypes = ["directional", "yield", "chart_pattern", "social_buzz", "copy_whale", "mempool_pressure"];
        if (slowTypes.includes(opp.arb.type)) {
          const d = await this.executeDirectionalTrade(opp, poolStates);
          d.oppType = opp.arb.type;
          details.push(d);
        } else if (false) {
          details.push({
            pool: opp.poolKeys.join("+"),
            opportunity: opp.arb.path,
            stage: "failed",
            reason: "Slow path: unsupported opportunity type",
          });
        }
      }
    }

    return details;
  }

  // ── Whale signal log helper ────────────────────────────

  private async logWhaleSignals(mints: string[]): Promise<void> {
    for (const mint of mints) {
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
  }

  // ── Build an AI-generated directional opportunity ─────

  private buildDirectionalOpportunity(
    direction: "bullish" | "bearish" | "neutral",
    aiScore: number,
    p1State: PoolState,
  ): DiscoveredOpportunity {
    const cfg = getConfig();
    // Cap trade size at 10% of flash_loan_max as a devnet safety measure
    const maxCapital = Math.min(cfg.capital.flash_loan_max_usd * 0.1, 5);

    const isBullish = direction === "bullish";
    const tokenIn  = isBullish ? "fUSDC" : "fSOL";
    const tokenOut = isBullish ? "fSOL"  : "fUSDC";
    const amountIn = maxCapital;

    // Estimate output via AMM formula
    const feeNum = cfg.amm.fee_numerator;
    const feeDen = cfg.amm.fee_denominator;
    const [resIn, resOut] = isBullish
      ? [p1State.reserveA, p1State.reserveB]
      : [p1State.reserveB, p1State.reserveA];
    const expectedOut = resIn > 0 && resOut > 0
      ? (amountIn * feeNum * resOut) / (resIn * feeDen + amountIn * feeNum)
      : 0;

    const arb: ArbOpportunity = {
      type: "directional",
      path: `AI directional: ${tokenIn}→${tokenOut} (score ${aiScore.toFixed(2)}, ${direction})`,
      tokenIn,
      tokenOut,
      amountIn,
      expectedProfit: expectedOut - amountIn, // may be negative — that's fine, AI predicts gain later
      profitPercent: amountIn > 0 ? ((expectedOut - amountIn) / amountIn) * 100 : 0,
      pools: [p1State],
      timestamp: Date.now(),
    };

    return {
      arb,
      poolStates: [p1State],
      involvedMints: [isBullish ? this.tokens.tokenB.mint : this.tokens.tokenA.mint],
      poolKeys: ["pool1"],
      isTriangular: false,
    };
  }

  // ── Execute a directional (own-capital) swap ───────────

  private async executeDirectionalTrade(
    opp: DiscoveredOpportunity,
    poolStates: Map<string, PoolState>,
  ): Promise<TickDetail> {
    const p1 = poolStates.get("pool1");
    if (!p1) {
      return {
        pool: opp.poolKeys.join("+"),
        opportunity: opp.arb.path,
        stage: "failed",
        reason: "pool1 state not available for directional trade",
      };
    }

    const cfg = getConfig();
    const isBullish = opp.arb.tokenIn === "fUSDC";
    const amountIn = opp.arb.amountIn;
    const feeNum = cfg.amm.fee_numerator;
    const feeDen = cfg.amm.fee_denominator;

    const [resIn, resOut] = isBullish
      ? [p1.reserveA, p1.reserveB]
      : [p1.reserveB, p1.reserveA];

    if (resIn <= 0 || resOut <= 0) {
      return {
        pool: opp.poolKeys.join("+"),
        opportunity: opp.arb.path,
        stage: "failed",
        reason: "pool1 has zero reserves",
      };
    }

    const expectedOut = (amountIn * feeNum * resOut) / (resIn * feeDen + amountIn * feeNum);

    // Plan single-hop swap on pool1
    const route = this.routePlanner.planSingleHop("pool1", amountIn, isBullish, expectedOut);

    logger.info({
      direction: isBullish ? "fUSDC→fSOL" : "fSOL→fUSDC",
      amountIn,
      expectedOut: expectedOut.toFixed(4),
    }, "  → Directional swap");

    try {
      // Prefer the vault-routed path: tokens move under the user vault PDA's
      // authority via CPI into the AMM. Bot pays fees but never holds the
      // tokens. Fall back to direct AMM swap only if no vault is configured.
      const vaultReader = this.protection.getVaultReader();
      let tx;
      if (vaultReader && (await vaultReader.exists())) {
        const mintInPk = new PublicKey(
          isBullish ? this.tokens.tokenA.mint : this.tokens.tokenB.mint,
        );
        const mintOutPk = new PublicKey(
          isBullish ? this.tokens.tokenB.mint : this.tokens.tokenA.mint,
        );
        tx = await this.txBuilder.buildVaultSwapTransaction({
          route, pools: this.pools,
          estimatedProfit: opp.arb.expectedProfit,
          vaultProgram: vaultReader.getVaultProgram(),
          vaultPda: vaultReader.getVaultPda(),
          botPubkey: this.userKeypair.publicKey,
          mintIn: mintInPk,
          mintOut: mintOutPk,
          ammProgramId: this.ammProgram.programId,
        });
      } else {
        tx = await this.txBuilder.buildSwapTransaction(route, this.pools, opp.arb.expectedProfit);
      }
      const result = await this.submitter.submit(tx, amountIn, "slow");

      if (result.success) {
        this.protection.recordResult(true);
        logger.info(`  → EXECUTED  tx=${result.signature?.slice(0, 16)}...`);
        return {
          pool: opp.poolKeys.join("+"),
          opportunity: opp.arb.path,
          stage: "executed",
          profit: expectedOut - amountIn,
          signature: result.signature ?? "",
        };
      } else {
        this.protection.recordResult(false);
        logger.info(`  → FAILED: ${result.reason}`);
        return {
          pool: opp.poolKeys.join("+"),
          opportunity: opp.arb.path,
          stage: "failed",
          reason: result.reason ?? "swap failed",
        };
      }
    } catch (e: any) {
      this.protection.recordResult(false);
      return {
        pool: opp.poolKeys.join("+"),
        opportunity: opp.arb.path,
        stage: "failed",
        reason: `directional swap threw: ${e.message}`,
      };
    }
  }

  // ── Execute a liquidation via programs-lending ─────────

  private async executeLiquidation(
    opp: DiscoveredOpportunity,
    poolStates: Map<string, PoolState>,
  ): Promise<TickDetail> {
    const detail: TickDetail = {
      pool: opp.poolKeys.join("+"),
      opportunity: opp.arb.path,
      stage: "failed",
    };

    // Lazy-init the lending client (requires config/devnet_lending.json).
    if (!this.lendingClient) {
      try {
        this.lendingClient = new LendingClient(this.connection, {
          publicKey: this.userKeypair.publicKey,
          signTransaction: async (tx: any) => { tx.sign(this.userKeypair); return tx; },
          signAllTransactions: async (txs: any[]) => { txs.forEach(tx => tx.sign(this.userKeypair)); return txs; },
        });
      } catch (e: any) {
        detail.reason = `LendingClient init failed: ${e.message}`;
        return detail;
      }
    }

    // Metadata stored on the opportunity by LiquidationHunter / detect_liquidations.
    const meta = (opp.arb as any).liqMeta as {
      positionPda: string;
      collateralMint: string;
      debtMint: string;
      collateralAmount: number;
      debtAmount: number;
    } | undefined;

    if (!meta?.positionPda) {
      detail.reason = "Missing liqMeta.positionPda on opportunity — position not registered on-chain";
      return detail;
    }

    // Derive collateral price in bps from current pool reserves.
    const p1 = poolStates.get("pool1");
    if (!p1) {
      detail.reason = "pool1 state unavailable for price derivation";
      return detail;
    }
    // collateral (fSOL) price in fUSDC = reserveA / reserveB (pool1 is fUSDC/fSOL)
    const collateralPriceBps = Math.round((p1.reserveA / p1.reserveB) * 10_000);

    const positionPda = new PublicKey(meta.positionPda);
    const collateralMint = new PublicKey(meta.collateralMint);

    // Liquidator receives collateral into the bot wallet's ATA.
    const liquidatorCollateral = getAssociatedTokenAddressSync(
      collateralMint,
      this.userKeypair.publicKey,
      false,
    );

    logger.info(
      {
        positionPda: positionPda.toBase58(),
        collateralPriceBps,
        collateralAmount: meta.collateralAmount,
        debtAmount: meta.debtAmount,
      },
      "  → Liquidating position",
    );

    try {
      const tx = await this.lendingClient.buildLiquidateTransaction({
        positionPda,
        collateralMint,
        liquidatorCollateral,
        botPublicKey: this.userKeypair.publicKey,
        collateralPriceBps,
      });

      const { blockhash, lastValidBlockHeight } =
        await this.connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.lastValidBlockHeight = lastValidBlockHeight;
      tx.feePayer = this.userKeypair.publicKey;
      tx.sign(this.userKeypair);

      const sig = await this.connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
      });
      await this.connection.confirmTransaction(
        { signature: sig, blockhash, lastValidBlockHeight },
        "confirmed",
      );

      // Profit = collateral received × price – debt recorded (in fUSDC terms)
      const collateralValueUsd = meta.collateralAmount * (p1.reserveA / p1.reserveB);
      const profit = collateralValueUsd - meta.debtAmount;

      this.protection.recordResult(true);
      logger.info({ sig: sig.slice(0, 16), profit: profit.toFixed(4) }, "  → Liquidation executed");

      return {
        pool: opp.poolKeys.join("+"),
        opportunity: opp.arb.path,
        stage: "executed",
        profit,
        signature: sig,
      };
    } catch (e: any) {
      this.protection.recordResult(false);
      detail.reason = `liquidate tx threw: ${e.message}`;
      return detail;
    }
  }

  // ── Execute a triangular arb via flash loan ────────────

  private async executeTriangularArb(
    opp: DiscoveredOpportunity,
    poolStates: Map<string, PoolState>,
  ): Promise<TickDetail> {
    const cfgEarly = getConfig();
    // Per-trade capital cap: precedence (lowest wins → smallest cap)
    //   1. user config maxTradeUsd        (per-user setting from BotBuilder)
    //   2. settings.yaml capital.flash_loan_max_usd (operator-wide ceiling)
    //   3. opportunity-level amountIn     (sized by detector for THIS gap)
    // This way: depositing more / raising the per-user max actually scales
    // the borrow amount instead of being clamped to a tiny default.
    const userMax = (this.userConfig as any)?.maxTradeUsd;
    const operatorMax = cfgEarly.capital.flash_loan_max_usd;
    const oppMax = opp.arb.amountIn;
    const borrowAmount = Math.min(
      ...[userMax, operatorMax, oppMax].filter((v) => typeof v === "number" && v > 0) as number[],
    );

    let flashVaultConfig: any;
    try {
      flashVaultConfig = JSON.parse(fs.readFileSync("config/devnet_flash_vault.json", "utf-8"));
    } catch {
      return {
        pool: opp.poolKeys.join("+"),
        opportunity: opp.arb.path,
        stage: "failed",
        reason: "Flash vault config missing — run: npx ts-node scripts/devnet/setup/06_setup_flash_vault.ts",
      };
    }

    const p1 = poolStates.get("pool1")!;
    const p2 = poolStates.get("pool2")!;
    const p3 = poolStates.get("pool3")!;

    const feeNum = cfgEarly.amm.fee_numerator;
    const feeDen = cfgEarly.amm.fee_denominator;
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
        reason: "Not profitable after AMM fees",
      };
    }

    // Estimate the Solana network fee for this flash-loan arb (priority fee
    // + base fee × signers + a small buffer for compute units), and refuse to
    // execute if expected profit doesn't beat it by a configurable safety margin.
    // This prevents the "+$0.0001 / -$0.15" loss pattern we kept seeing on
    // tiny gaps with small borrow amounts.
    const minProfitMultiplier = (this.userConfig as any)?.minProfitMultiplier ?? 1.5;
    // Rough estimate: priority fee microlamports × CU × 1e-15 SOL → fUSDC at ~$170/SOL.
    // Use the configured priority fee as the worst-case unit cost.
    const priorityMicroLamports = cfgEarly.fees?.base_priority_fee_microlamports ?? 50_000;
    const computeUnits = cfgEarly.fees?.flash_loan_compute_units ?? 400_000;
    const baseFeeSol = 0.000005; // 5_000 lamports per signature ≈ Solana base fee
    const solUsd = 170;          // rough; on mainnet pull from Pyth
    const networkFeeSol = baseFeeSol + (priorityMicroLamports * computeUnits) / 1e15;
    const networkFeeUsd = networkFeeSol * solUsd;
    const minRequiredProfit = networkFeeUsd * minProfitMultiplier;

    if (profit < minRequiredProfit) {
      logger.info({
        borrow: borrowAmount.toFixed(2),
        expectedProfit: profit.toFixed(4),
        networkFeeEst: networkFeeUsd.toFixed(4),
        threshold: minRequiredProfit.toFixed(4),
      }, "  → Skipped: expected profit below network-fee guard");
      return {
        pool: opp.poolKeys.join("+"),
        opportunity: opp.arb.path,
        stage: "failed",
        reason: `Profit $${profit.toFixed(4)} below fee threshold $${minRequiredProfit.toFixed(4)}`,
      };
    }

    const route = this.routePlanner.planTriangularArb(
      borrowAmount, step1Out, step2Out, step3Out, isReverse,
    );

    const sweepReader = this.protection.getVaultReader();

    // Routing decision (priority order, top→bottom):
    //   1. useVaultFlashArb: vault PDA owns the flash loan + swaps + repay.
    //      Bot wallet never holds tokens. Cleanest trust model, scales like
    //      a flash loan (no own-capital requirement).
    //   2. useVaultArb: vault uses its own deposited capital, no flash loan.
    //      Vault PDA custodian, but limited to vault balance.
    //   3. default: bot wallet flash-loan with profit sweep into vault.
    const useVaultFlashArb = (this.userConfig as any)?.useVaultFlashArb === true;
    const useVaultArb = (this.userConfig as any)?.useVaultArb === true;

    const vaultExists = !!(sweepReader && (await sweepReader.exists()));
    let vaultArbReady = false;
    if (useVaultArb && vaultExists) {
      const vaultBal = await sweepReader!.getBalance();
      vaultArbReady = vaultBal >= borrowAmount;
    }

    let flashTx: import("@solana/web3.js").Transaction;
    if (useVaultFlashArb && vaultExists && sweepReader) {
      const hopPools = isReverse
        ? { p1: this.pools.pool3, p2: this.pools.pool2, p3: this.pools.pool1 }
        : { p1: this.pools.pool1, p2: this.pools.pool2, p3: this.pools.pool3 };
      const directions: [boolean, boolean, boolean] = isReverse
        ? [true, false, false]
        : [true, true, false];

      flashTx = await this.txBuilder.buildVaultArbViaFlashTransaction({
        pools: hopPools,
        directions,
        borrowAmount,
        estimatedProfit: profit,
        vaultProgram: sweepReader.getVaultProgram(),
        vaultPda: sweepReader.getVaultPda(),
        botPubkey: this.userKeypair.publicKey,
        mintA: new PublicKey(this.tokens.tokenA.mint),
        mintB: new PublicKey(this.tokens.tokenB.mint),
        mintC: new PublicKey(this.tokens.tokenC.mint),
        ammProgramId: this.ammProgram.programId,
        flashProgramId: new PublicKey(flashVaultConfig.programId ?? "57qgGcR2anVG58VLymRe1vyui2eUjtefFPmsYFUN3acH"),
        flashConfig: new PublicKey(flashVaultConfig.flashConfig),
        flashVault: new PublicKey(flashVaultConfig.vault),
        decimalsA: this.tokens.tokenA.decimals,
      });
    } else if (vaultArbReady && sweepReader) {
      // Pool order in route reflects hop order; map directions for bot_arb.
      // For "forward" arb: pool1(A→B) pool2(B→C) pool3(C→A) → directions
      // are determined by which side of each pool we enter.
      const hopPools = isReverse
        ? { p1: this.pools.pool3, p2: this.pools.pool2, p3: this.pools.pool1 }
        : { p1: this.pools.pool1, p2: this.pools.pool2, p3: this.pools.pool3 };
      const directions: [boolean, boolean, boolean] = isReverse
        ? [true, false, false]   // mirror of forward
        : [true, true, false];

      flashTx = await this.txBuilder.buildVaultArbTransaction({
        pools: hopPools,
        directions,
        amountIn: borrowAmount,
        estimatedProfit: profit,
        vaultProgram: sweepReader.getVaultProgram(),
        vaultPda: sweepReader.getVaultPda(),
        botPubkey: this.userKeypair.publicKey,
        mintA: new PublicKey(this.tokens.tokenA.mint),
        mintB: new PublicKey(this.tokens.tokenB.mint),
        mintC: new PublicKey(this.tokens.tokenC.mint),
        ammProgramId: this.ammProgram.programId,
        decimalsA: this.tokens.tokenA.decimals,
      });
    } else {
      // Default: flash-loan path. Sweep profit into vault if configured.
      let profitSweep: { vaultPda: PublicKey; baseMint: PublicKey; profitRaw: BN } | undefined;
      if (sweepReader && profit > 0) {
        const profitRaw = new BN(Math.floor(profit * 10 ** this.tokens.tokenA.decimals));
        profitSweep = {
          vaultPda: sweepReader.getVaultPda(),
          baseMint: new PublicKey(this.tokens.tokenA.mint),
          profitRaw,
        };
      }
      flashTx = await this.txBuilder.buildFlashLoanArbTransaction(
        route, this.pools, this.flashProgram,
        flashVaultConfig.flashConfig, flashVaultConfig.vault,
        borrowAmount, this.tokens.tokenA.decimals,
        profitSweep,
      );
    }

    // Snapshot the correct balance before tx:
    // - vault path → vault PDA's base-token ATA
    // - bot-wallet flash path → bot wallet's base-token ATA
    const vaultBalAccount = sweepReader ? await sweepReader.getBaseTokenAta() : null;
    const measurePubkey = vaultBalAccount ?? new PublicKey(this.tokens.tokenA.account);

    const balBefore = await this.connection.getTokenAccountBalance(measurePubkey);

    const execResult = await this.submitter.submit(flashTx, 0, "fast");

    if (execResult.success) {
      const balAfter = await this.connection.getTokenAccountBalance(measurePubkey);
      const realProfit = parseFloat(balAfter.value.uiAmountString!) -
        parseFloat(balBefore.value.uiAmountString!);

      logger.info(`  → EXECUTED  profit=+${realProfit.toFixed(4)} fUSDC  tx=${execResult.signature?.slice(0, 16)}...`);

      // Invalidate vault cache so next /status poll sees the updated balance.
      sweepReader?.invalidate();

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
    await this.ammProgram.methods
      .swap(new BN(5000 * 10 ** this.tokens.tokenA.decimals), new BN(1), true)
      .accounts({
        pool: new PublicKey(this.pools.pool1.address),
        tokenAVault: new PublicKey(this.pools.pool1.tokenAVault),
        tokenBVault: new PublicKey(this.pools.pool1.tokenBVault),
        userTokenA: new PublicKey(this.tokens.tokenA.account),
        userTokenB: new PublicKey(this.tokens.tokenB.account),
        user: this.userKeypair.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
    logger.info("Price gap created");
  }

  // ── Build market snapshot from pool states ─────────────

  private buildMarketSnapshot(
    poolStates: Map<string, PoolState>,
    opportunities: DiscoveredOpportunity[],
  ): MarketSnapshot {
    const poolEntries = Object.entries(this.pools) as [string, any][];
    const pools: PoolSnapshot[] = [];

    for (const [key, pool] of poolEntries) {
      const state = poolStates.get(key);
      if (!state) continue;
      pools.push({
        key,
        name: pool.name ?? key,
        tokenA: pool.tokenA ?? "unknown",
        tokenB: pool.tokenB ?? "unknown",
        reserveA: state.reserveA,
        reserveB: state.reserveB,
        price: state.price,
        priceInverse: state.reserveB > 0 ? state.reserveA / state.reserveB : 0,
        tvl: state.reserveA * 2, // approximate: reserveA * 2 (both sides ~equal value)
      });
    }

    const opps: OpportunitySnapshot[] = opportunities.map(opp => ({
      type: opp.arb.type,
      path: opp.arb.path,
      tokenIn: opp.arb.tokenIn,
      tokenOut: opp.arb.tokenOut,
      amountIn: opp.arb.amountIn,
      estimatedProfit: opp.arb.expectedProfit,
      profitPercent: opp.arb.profitPercent,
      pools: opp.poolKeys,
      timestamp: opp.arb.timestamp,
    }));

    return { pools, opportunities: opps, timestamp: Date.now() };
  }

  // ── Public: tick() ─────────────────────────────────────

  async tick(): Promise<TickResult> {
    const poolStates: Map<string, PoolState> = this.poolMonitor
      ? this.poolMonitor.getAllStates()
      : await this.readPoolStatesFromRpc();

    await this.ingestionService.ingestPoolStates(
      poolStates as unknown as Map<string, CandlePoolState>,
      (key) => this.mintForPool(key),
    ).catch((e: any) => logger.warn({ error: e.message }, "Candle ingestion failed"));

    await this.refreshAIDecision();

    return {
      poolsScanned: poolStates.size,
      opportunitiesFound: 0,
      safetyRejected: 0,
      guardRejected: 0,
      tradesExecuted: 0,
      tradesFailed: 0,
      details: [],
      vault: await this.readVaultState(),
    };
  }

  private async readVaultState(): Promise<{ balance: number; isActive: boolean; totalDeposits: number; totalWithdrawals: number; profit: number } | null> {
    const reader = this.protection.getVaultReader();
    if (!reader) return null;
    try {
      const s = await reader.getState() as any;
      const decimals = this.tokens.tokenA.decimals;
      const totalDeposits = (s.totalDeposits ?? 0) / 10 ** decimals;
      const totalWithdrawals = (s.totalWithdrawals ?? 0) / 10 ** decimals;
      const profit = s.balance - (totalDeposits - totalWithdrawals);
      return { balance: s.balance, isActive: s.isActive, totalDeposits, totalWithdrawals, profit };
    } catch {
      return null;
    }
  }

  // ── Background monitors ────────────────────────────────
  // Starts NewsFeedMonitor (and could be extended to other always-on
  // monitors). Used by the viewer engine which calls tick() manually
  // and doesn't go through startLoop().
  startNewsFeed(): void {
    if (this.newsFeedMonitor) {
      this.newsFeedMonitor.start().catch((e: any) => {
        logger.warn({ error: e.message }, "NewsFeedMonitor failed to start");
      });
    }
  }

  // ── Start event-driven reactors (called by UserRegistry per-user) ──────────
  // Starts ArbReactor + LiquidationReactor on the attached PoolMonitor, plus
  // the always-on monitors (mempool, news). Does NOT start a blocking loop —
  // UserRegistry's runLoop() drives the slow-tick cadence.
  // In API mode, each user lane provides the enqueue callback so reactors
  // are pure event sources — they never call execution code directly.
  startReactors(opts: { enqueue: (event: import("../graph/events").LaneEvent) => void; userId: string }): void {
    if (!this.poolMonitor) {
      logger.warn("startReactors() called without a PoolMonitor — skipping");
      return;
    }

    this.mempoolMonitor.start().catch((e: any) =>
      logger.warn({ error: e.message }, "MempoolMonitor failed to start"),
    );
    if (this.newsFeedMonitor) {
      this.newsFeedMonitor.start().catch((e: any) =>
        logger.warn({ error: e.message }, "NewsFeedMonitor failed to start"),
      );
    }

    this.arbReactor = new ArbReactor({
      poolMonitor: this.poolMonitor,
      arbDetector: this.arbDetector,
      tokens: this.tokens,
      userId: opts.userId,
      enqueue: opts.enqueue,
      getUserConfig: () => this.userConfig,
    });
    this.arbReactor.start();

    this.liquidationReactor = new LiquidationReactor({
      connection: this.connection,
      poolMonitor: this.poolMonitor,
      liquidationHunter: this.liquidationHunter,
      lendingClient: this.lendingClient,
      tokens: this.tokens,
      pools: this.pools,
      baseMint: this.baseMint,
      userId: opts.userId,
      enqueue: opts.enqueue,
      getUserConfig: () => this.userConfig,
    });
    this.liquidationReactor.start();

    logger.info("Trading engine: event-driven reactors started (arb + liquidation)");
  }

  // ── Loop control ───────────────────────────────────────

  async startLoop(intervalMs: number = 5000): Promise<void> {
    this.running = true;

    // Always-on monitors (event-driven internally).
    this.mempoolMonitor.start().catch((e: any) =>
      logger.warn({ error: e.message }, "MempoolMonitor failed to start"),
    );
    if (this.newsFeedMonitor) {
      this.newsFeedMonitor.start().catch((e: any) =>
        logger.warn({ error: e.message }, "NewsFeedMonitor failed to start"),
      );
    }

    // ── Event-driven path ────────────────────────────────
    if (this.poolMonitor) {
      // Load initial pool states + subscribe to all vault accounts.
      await this.poolMonitor.start();

      // Single-user enqueue shim — routes arb/liq events back to handleFastOpportunity.
      const singleUserEnqueue = (event: import("../graph/events").LaneEvent) => {
        if (event.kind === "arb_opportunity" || event.kind === "liq_opportunity") {
          this.handleFastOpportunity(event.opp, event.poolStates).catch(() => {});
        }
      };

      // Arb reactor: fires immediately on any pool reserve change.
      this.arbReactor = new ArbReactor({
        poolMonitor: this.poolMonitor,
        arbDetector: this.arbDetector,
        tokens: this.tokens,
        userId: "single-user",
        enqueue: singleUserEnqueue,
        getUserConfig: () => this.userConfig,
      });
      this.arbReactor.start();

      // Liquidation reactor: also fires on pool reserve changes.
      this.liquidationReactor = new LiquidationReactor({
        connection: this.connection,
        poolMonitor: this.poolMonitor,
        liquidationHunter: this.liquidationHunter,
        lendingClient: this.lendingClient,
        tokens: this.tokens,
        pools: this.pools,
        baseMint: this.baseMint,
        userId: "single-user",
        enqueue: singleUserEnqueue,
        getUserConfig: () => this.userConfig,
      });
      this.liquidationReactor.start();

      // Candle reactor: Binance WebSocket — fires on each 1-minute close.
      // Triggers immediate AI decision refresh and directional trade if confident.
      this.candleReactor = new CandleReactor({ symbol: "solusdt", interval: "1m" });
      this.candleReactor.on("candle_closed", (candle: ClosedCandle) => {
        this.onCandleClosed(candle).catch((e: any) =>
          logger.warn({ error: e.message }, "onCandleClosed threw"),
        );
      });
      this.candleReactor.start();

      logger.info("Trading engine: event-driven mode active (pool monitor + reactors)");
    } else {
      logger.warn("Trading engine: no PoolMonitor attached — using legacy poll mode");
    }

    // ── Slow tick: signal detectors + yield + status ─────
    // Runs every intervalMs (default 5s) regardless of mode.
    // When event-driven reactors handle arb/liquidation/directional,
    // this only runs chart/social/whale/mempool/yield detectors.
    logger.info({ intervalMs }, "Trading engine slow tick started");
    while (this.running) {
      try {
        await this.slowTick();
      } catch (e: any) {
        logger.error({ error: e.message }, "Slow tick failed");
      }
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }

    logger.info("Trading engine loop stopped");
  }

  stop(): void {
    this.running = false;
    this.mempoolMonitor.stop().catch(() => {});
    this.newsFeedMonitor?.stop().catch(() => {});
    this.poolMonitor?.stop().catch(() => {});
    this.liquidationReactor?.stop();
    if (this.candleReactor) this.candleReactor.stop();
    logger.info("Trading engine stopping...");
  }

  getProtectionStatus() {
    return this.protection.getStatus();
  }

  getLastDecision(): DecisionResult | null {
    return this.lastDecision;
  }
}
