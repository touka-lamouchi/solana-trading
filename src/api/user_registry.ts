import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import fs from "fs";

import { TradingEngine, TickDetail, TickResult, MarketSnapshot } from "../engine/trading_engine";
import { LendingClient } from "../layer2_execution/lending_client";
import { PoolMonitor } from "../infrastructure/pool_monitor";
import { CandleReactor } from "../infrastructure/candle_reactor";
import { ProtectionManager } from "../protection/protection_manager";
import { CacheManager } from "../cache/cache_manager";
import { WhaleTracker } from "../layer1_opportunity/whale_tracker";
import { WhaleCache } from "../cache/whale_cache";
import { MainnetRPC } from "../infrastructure/mainnet_rpc";
import { VaultReader } from "../vault/vault_reader";
import { UserConfigStore, UserConfig } from "./user_config";
import { getConfig } from "../utils/config";
import { logger } from "../utils/logger";
import { buildGraph } from "../graph/build";
import { UserLane } from "../graph/user_lane";
import type { GraphTickResult } from "../graph/entries";
import type { EngineDeps } from "../graph/deps";
import type { DecisionResult } from "../layer1_opportunity/decision_model";

export interface EngineStatus {
  userId: string;
  running: boolean;
  lastTick: TickResult | null;
  protectionStatus: any;
  config: UserConfig;
}

interface UserInstance {
  engine: TradingEngine;
  whaleTracker: WhaleTracker | null;
  protection: ProtectionManager;
  lane: UserLane;
  previousDecision: DecisionResult | null;
  running: boolean;
  lastTick: TickResult | null;
  lastMarket: MarketSnapshot | null;
  loopPromise: Promise<void> | null;
  config: UserConfig;
  // Accumulated stats for frontend
  tradesToday: number;
  tradesWon: number;
  dailyPnl: number;
}

export class UserRegistry {
  private users = new Map<string, UserInstance>();
  private connection: Connection;
  private cache: CacheManager;
  private configStore: UserConfigStore;
  private ammProgram: any;
  private flashProgram: any;
  private pools: any;
  private tokens: any;
  private dirtyTokens: any;

  // Event listeners for WebSocket broadcasting
  private tickListeners = new Map<string, ((result: TickResult) => void)[]>();

  // Shared pool monitor — one instance, all user engines subscribe to it.
  // Created lazily when the first user starts.
  private sharedPoolMonitor: PoolMonitor | null = null;
  private monitorStarted = false;

  // Shared candle reactor — one Binance WS connection, fans out to all user lanes.
  private sharedCandleReactor: CandleReactor | null = null;

  constructor(opts: {
    connection: Connection;
    cache: CacheManager;
    ammProgram: any;
    flashProgram: any;
    pools: any;
    tokens: any;
    dirtyTokens: any;
  }) {
    this.connection = opts.connection;
    this.cache = opts.cache;
    this.configStore = new UserConfigStore(opts.cache);
    this.ammProgram = opts.ammProgram;
    this.flashProgram = opts.flashProgram;
    this.pools = opts.pools;
    this.tokens = opts.tokens;
    this.dirtyTokens = opts.dirtyTokens;
  }

  async startUser(userId: string, walletKeypair: Keypair): Promise<void> {
    if (this.users.has(userId)) {
      throw new Error(`User ${userId} is already running`);
    }

    const config = await this.configStore.get(userId);
    const globalConfig = getConfig();

    // Per-user protection manager
    const protection = new ProtectionManager({
      autoPause: { maxConsecutiveFailures: globalConfig.protection.max_consecutive_failures },
      drawdown: {
        dailyLimit: config.dailyLimitUsd,
        autoPausePercent: globalConfig.protection.drawdown_pause_pct,
      },
      slippage: { maxSlippageBps: globalConfig.protection.slippage_max_bps },
      tradingHours: {
        enabled: config.tradingHoursStart !== "00:00" || config.tradingHoursEnd !== "23:59",
        startHour: parseInt(config.tradingHoursStart.split(":")[0] ?? "0"),
        endHour: parseInt(config.tradingHoursEnd.split(":")[0] ?? "23"),
      },
    });

    // Per-user vault: derive PDA from the user's pubkey.
    // Prefer userId if it parses as a valid pubkey (Phantom flow);
    // fall back to walletKeypair.publicKey (devnet shared wallet flow).
    if (globalConfig.vault?.program_id) {
      try {
        let userPubkey: PublicKey;
        try {
          userPubkey = new PublicKey(userId);
        } catch {
          userPubkey = walletKeypair.publicKey;
        }
        const baseTokenName = globalConfig.vault.base_mint ?? "fUSDC";
        const baseTokenEntry = Object.values(this.tokens).find(
          (t: any) => t.name === baseTokenName,
        ) as any;
        if (!baseTokenEntry) {
          throw new Error(`Base token ${baseTokenName} not in tokens config`);
        }
        const vaultReader = new VaultReader({
          connection: this.connection,
          signerForReads: walletKeypair,
          userPubkey,
          baseMint: new PublicKey(baseTokenEntry.mint),
        });
        protection.attachVaultReader(vaultReader);
        const vs = await vaultReader.getState();
        logger.info({
          userId,
          userPubkey: userPubkey.toBase58(),
          exists: vs.exists,
          balance: vs.balance,
          active: vs.isActive,
        }, "Per-user vault attached");
      } catch (e: any) {
        logger.warn({ userId, error: e.message }, "VaultReader init failed — no vault gating");
      }
    }

    // Per-user engine
    const engine = new TradingEngine({
      connection: this.connection,
      ammProgram: this.ammProgram,
      flashProgram: this.flashProgram,
      pools: this.pools,
      tokens: this.tokens,
      dirtyTokens: this.dirtyTokens,
      cache: this.cache,
      protection,
      userKeypair: walletKeypair,
    });

    // Set user config for opportunity filtering
    engine.setUserConfig(config);

    // Per-user whale tracker
    let whaleTracker: WhaleTracker | null = null;
    if (globalConfig.whale_tracking?.enabled) {
      const whaleCache = new WhaleCache(this.cache);
      const mainnetMode = globalConfig.ai?.data_source === "mainnet";
      const whaleConnection = mainnetMode ? new MainnetRPC().getConnection() : this.connection;
      const trackedMints = mainnetMode && globalConfig.ai?.target_mint_mainnet
        ? [globalConfig.ai.target_mint_mainnet]
        : [
            this.tokens.tokenA.mint,
            this.tokens.tokenB.mint,
            this.tokens.tokenC.mint,
          ];
      whaleTracker = new WhaleTracker(whaleConnection, whaleCache, trackedMints, {
        scanIntervalMs: globalConfig.whale_tracking.scan_interval_ms,
        minWhaleBalancePct: globalConfig.whale_tracking.min_whale_balance_pct,
        accumulationThresholdPct: globalConfig.whale_tracking.accumulation_threshold_pct,
        distributionThresholdPct: globalConfig.whale_tracking.distribution_threshold_pct,
      });
      whaleTracker.startLoop();
    }

    const instance: UserInstance = {
      engine,
      whaleTracker,
      protection,
      lane: null!,
      previousDecision: null,
      running: true,
      lastTick: null,
      lastMarket: null,
      loopPromise: null,
      config,
      tradesToday: 0,
      tradesWon: 0,
      dailyPnl: 0,
    };

    this.users.set(userId, instance);

    // Attach the shared PoolMonitor (lazy-start on first user).
    if (!this.sharedPoolMonitor) {
      this.sharedPoolMonitor = new PoolMonitor({
        connection: this.connection,
        pools: this.pools,
        tokens: this.tokens,
      });
    }
    if (!this.monitorStarted) {
      this.monitorStarted = true;
      this.sharedPoolMonitor.start().then(() => {
        logger.info("Shared PoolMonitor started for user registry");
      }).catch((e: any) => {
        logger.warn({ error: e.message }, "Shared PoolMonitor failed to start");
        this.monitorStarted = false; // allow retry
      });
    }
    engine.attachPoolMonitor(this.sharedPoolMonitor);

    // Build EngineDeps after attachPoolMonitor so poolMonitor is set.
    const wsEmit = (event: any) => {
      const listeners = this.tickListeners.get(userId) ?? [];
      for (const listener of listeners) {
        try { listener(event); } catch { /* ignore */ }
      }
    };
    const detectors = engine.exposeDetectors();

    // Lazy-init LendingClient — only available after 08_deploy_lending.ts has run.
    let lendingClient: LendingClient | undefined;
    try {
      lendingClient = new LendingClient(this.connection, walletKeypair as any);
      detectors.liquidationHunter.setLendingClient(lendingClient);
      logger.info({ userId }, "LendingClient attached to LiquidationHunter");
    } catch (e: any) {
      logger.debug({ userId, msg: e.message }, "LendingClient not available — liquidations use Redis fallback");
    }

    const baseMintEntry = Object.values(this.tokens).find((t: any) => t.name === "fUSDC") as any;
    const deps: EngineDeps = {
      engine,
      protection,
      cache: this.cache,
      connection: this.connection,
      poolMonitor: this.sharedPoolMonitor,
      pools: this.pools,
      tokens: this.tokens,
      baseMint: baseMintEntry?.mint ?? "",
      userId,
      arbDetector: detectors.arbDetector,
      yieldMonitor: detectors.yieldMonitor,
      liquidationHunter: detectors.liquidationHunter,
      chartPatternDetector: detectors.chartPatternDetector,
      socialBuzzDetector: detectors.socialBuzzDetector,
      whaleCopyDetector: detectors.whaleCopyDetector,
      mempoolPressureDetector: detectors.mempoolPressureDetector,
      decisionModel: detectors.decisionModel,
      ingestionService: detectors.ingestionService,
      safety: detectors.safety,
      router: detectors.router,
      ...(lendingClient ? { lendingClient } : {}),
      wsEmit,
      getUserConfig: () => instance.config as any,
    };
    const graph = buildGraph(deps);
    const lane = new UserLane(deps, graph, (gtr) => this.handleGraphResult(userId, instance, gtr));
    instance.lane = lane;

    // Route fast/slow opportunity details to the WS broadcaster.
    engine.onDetail = (detail) => this.broadcastDetail(userId, instance, detail);

    // Start arb + liquidation reactors — pure event sources, enqueue to the lane.
    engine.startReactors({ enqueue: (e) => lane.enqueue(e as any), userId });

    // Start the shared CandleReactor on the first user (one WS, fans out to all lanes).
    if (!this.sharedCandleReactor) {
      this.sharedCandleReactor = new CandleReactor({ symbol: "solusdt", interval: "1m" });
      this.sharedCandleReactor.on("candle_closed", (candle: any) => {
        const now = Date.now();
        for (const [uid, inst] of this.users) {
          if (inst.running) {
            inst.lane.enqueue({ kind: "candle_closed", userId: uid, candle, enqueuedAt: now });
          }
        }
      });
      this.sharedCandleReactor.start();
    }

    // Start the slow-tick loop in the background.
    instance.loopPromise = this.runLoop(userId, instance);

    logger.info({ userId, wallet: walletKeypair.publicKey.toBase58() }, "User engine started");
  }

  // Broadcast a single TickDetail to the user's WS listeners and persist
  // executed trades to Redis. Called by engine.onDetail for fast/slow events.
  private broadcastDetail(userId: string, instance: UserInstance, detail: TickDetail): void {
    const now = Date.now();
    const isViewer = instance.config.mode === "viewer";
    const listeners = this.tickListeners.get(userId) ?? [];

    // Accumulate stats
    if (!isViewer && detail.stage === "executed") {
      instance.tradesToday += 1;
      if ((detail.profit ?? 0) > 0) instance.tradesWon += 1;
      instance.dailyPnl += detail.profit ?? 0;
    }

    const event = {
      type: isViewer ? "opportunity_found"
          : detail.stage === "executed" ? "trade_executed"
          : detail.stage === "safety_rejected" ? "safety_rejected"
          : detail.stage === "guard_rejected" ? "protection_blocked"
          : detail.stage === "failed" ? "trade_rejected"
          : detail.stage,
      pool: detail.pool,
      pair: detail.opportunity,
      profit: detail.profit,
      reason: detail.reason,
      reasonCode: detail.reasonCode,        // Phase 4: machine-readable code
      cyclePath: detail.cyclePath,          // Phase 4: ["fUSDC","fSOL","fRAY","fUSDC"]
      hops: detail.hops,                    // Phase 4: hop count
      signature: detail.signature,
      oppType: detail.oppType,
      timestamp: now,
    };

    // Persist to Redis
    if (detail.stage === "executed" && !isViewer) {
      const date = new Date().toISOString().slice(0, 10);
      const key = `trades:${userId}:${date}`;
      const record = JSON.stringify({
        timestamp: now,
        pool: detail.pool,
        pair: detail.opportunity,
        profit: detail.profit ?? 0,
        signature: detail.signature ?? "",
        oppType: detail.oppType ?? "unknown",
        cyclePath: detail.cyclePath ?? null,
        hops: detail.hops ?? null,
      });
      this.cache.getClient().rpush(key, record).catch(() => {});
      this.cache.getClient().expire(key, 7 * 86400).catch(() => {});
    }

    for (const listener of listeners) {
      try { listener(event as any); } catch { /* ignore */ }
    }
  }

  private handleGraphResult(userId: string, instance: UserInstance, gtr: GraphTickResult): void {
    const result = gtr.tick;
    instance.lastTick = result;
    instance.previousDecision = gtr.lastDecision;

    // executed details were already broadcast (and counted) via engine.onDetail
    // inside execute_fast/execute_slow. Only broadcast non-executed details here
    // to avoid double-counting tradesToday/dailyPnl and duplicate WS events.
    for (const detail of result.details) {
      if (detail.stage === "executed") continue;
      this.broadcastDetail(userId, instance, detail);
    }
  }

  private async runLoop(userId: string, instance: UserInstance): Promise<void> {
    instance.lane.start();
    while (instance.running) {
      await new Promise(r => setTimeout(r, 250));
    }
    await instance.lane.stop();
  }

  async stopUser(userId: string): Promise<void> {
    const instance = this.users.get(userId);
    if (!instance) {
      throw new Error(`User ${userId} is not running`);
    }

    instance.running = false;
    instance.engine.stop();
    instance.whaleTracker?.stop();

    // Wait for loop to finish
    if (instance.loopPromise) {
      await instance.loopPromise;
    }

    this.users.delete(userId);
    this.tickListeners.delete(userId);

    // Stop shared resources when no more users are running.
    if (this.users.size === 0) {
      if (this.sharedPoolMonitor && this.monitorStarted) {
        this.sharedPoolMonitor.stop().catch(() => {});
        this.monitorStarted = false;
      }
      if (this.sharedCandleReactor) {
        this.sharedCandleReactor.stop();
        this.sharedCandleReactor = null;
      }
    }

    logger.info({ userId }, "User engine stopped");
  }

  getStatus(userId: string): any {
    const instance = this.users.get(userId);
    if (!instance) return null;

    const protStatus = instance.protection.getStatus();
    const decision = instance.previousDecision;

    return {
      userId,
      running: instance.running,
      mode: instance.config.mode ?? "active",
      // Fields the frontend expects
      dailyPnl: instance.dailyPnl,
      tradesToday: instance.tradesToday,
      winRate: instance.tradesToday > 0 ? instance.tradesWon / instance.tradesToday : 0,
      safetyScore: instance.lastTick
        ? Math.round(100 * (1 - (instance.lastTick.safetyRejected / Math.max(1, instance.lastTick.opportunitiesFound))))
        : 100,
      drawdownUsed: protStatus.drawdown?.spentToday ?? 0,
      drawdownLimit: instance.config.dailyLimitUsd,
      // Vault fields
      vaultExists: instance.lastTick?.vault != null,
      vaultBalance: instance.lastTick?.vault?.balance ?? 0,
      vaultActive: instance.lastTick?.vault?.isActive ?? false,
      vaultProfit: instance.lastTick?.vault?.profit ?? 0,
      vaultDeposits: instance.lastTick?.vault?.totalDeposits ?? 0,
      vaultWithdrawals: instance.lastTick?.vault?.totalWithdrawals ?? 0,
      vaultPda: instance.protection.getVaultReader()?.getVaultPda().toBase58() ?? null,
      // AI fields — populated from DecisionModel
      aiConfidence: decision?.aiScore ?? null,
      aiDirection: decision?.direction ?? null,
      sentiment: decision?.sentimentLabel ?? null,
      regime: decision?.regime ?? null,
      volatility: decision?.volLevel
                ?? (decision?.regime === "crash" ? "high"
                  : decision?.regime === "trending" ? "normal"
                  : decision?.regime === "ranging" ? "low"
                  : null),
      volExpansionProb: decision?.volExpansionProb ?? null,
      whaleActivity: decision?.whaleDirection === "bullish" ? "Accumulating"
                   : decision?.whaleDirection === "bearish" ? "Distributing"
                   : decision?.whaleDirection === "neutral" ? "Holding"
                   : null,
      // Raw data
      lastTick: instance.lastTick,
      market: instance.lastMarket,
      protectionStatus: protStatus,
      config: instance.config,
      // Per-user lane backpressure metrics
      queue: instance.lane?.metrics() ?? null,
    };
  }

  async updateConfig(userId: string, config: Partial<UserConfig>): Promise<UserConfig> {
    const updated = await this.configStore.set(userId, config);
    const instance = this.users.get(userId);
    if (instance) {
      instance.config = updated;

      // Propagate to running protection manager
      instance.protection.updateDrawdownLimit(updated.dailyLimitUsd);
      instance.protection.updateTradingHours(updated.tradingHoursStart, updated.tradingHoursEnd);

      // Propagate to running engine
      instance.engine.setUserConfig(updated);

      logger.info({ userId }, "Live config updated on running engine");
    }
    return updated;
  }

  async getConfig(userId: string): Promise<UserConfig> {
    return this.configStore.get(userId);
  }

  isRunning(userId: string): boolean {
    return this.users.has(userId) && (this.users.get(userId)?.running ?? false);
  }

  getActiveUserCount(): number {
    return this.users.size;
  }

  getActiveUserIds(): string[] {
    return Array.from(this.users.keys());
  }

  /**
   * Test the slow-path safety + protection chain against an arbitrary mint.
   *
   * Builds a synthetic DiscoveredOpportunity targeting the chosen mint and
   * pushes it through `engine.handleSlowOpportunity({bypassAiThreshold:true})`.
   * That method now broadcasts every terminal decision (safety_rejected,
   * guard_rejected, executed, failed) via onDetail, which drives the WS
   * pipeline. So the user sees the rejection in the frontend's activity log
   * exactly the same way real opportunities surface.
   *
   * No on-chain transaction is built or submitted unless safety + protection
   * both pass — and even then, the directional execution path requires a
   * matching pool and AI decision, which we don't synthesize. Realistic for
   * dirty/risky mints: they fail at S1/S2/S3/S4 immediately.
   */
  async testSlowOpportunity(userId: string, mint: string, opts: { amountIn?: number } = {}): Promise<TickDetail | undefined> {
    const instance = this.users.get(userId);
    if (!instance || !instance.running) return undefined;

    const pools = JSON.parse(fs.readFileSync("config/devnet_pools.json", "utf-8"));

    // Find any pool that includes this mint, for S2 honeypot's sell-simulation.
    let poolEntry: any = null;
    for (const k of Object.keys(pools)) {
      const p = pools[k];
      if (p.tokenAMint === mint || p.tokenBMint === mint) { poolEntry = { key: k, ...p }; break; }
    }

    // Build the cheapest legal DiscoveredOpportunity for the slow path. Most
    // fields are placeholders — handleSlowOpportunity only reads `involvedMints`,
    // `poolStates[0].address`, `arb.amountIn`, `arb.path`, `arb.type`.
    const stub: any = {
      arb: {
        type: "directional",
        path: `test-slow:${mint.slice(0, 8)}`,
        tokenIn: "fUSDC",
        tokenOut: mint.slice(0, 4),
        amountIn: opts.amountIn ?? 10,
        expectedProfit: 0,
        profitPercent: 0,
        pools: [],
        timestamp: Date.now(),
      },
      poolStates: poolEntry ? [{
        name: poolEntry.name ?? poolEntry.key,
        address: poolEntry.address,
        tokenAVault: poolEntry.tokenAVault,
        tokenBVault: poolEntry.tokenBVault,
        reserveA: 0, reserveB: 0, price: 0,
      }] : [],
      involvedMints: [mint],
      poolKeys: poolEntry ? [poolEntry.key] : ["test"],
      isTriangular: false,
    };

    return instance.engine.handleSlowOpportunity(stub, new Map(), { bypassAiThreshold: true });
  }

  // WebSocket tick listener management
  onTick(userId: string, listener: (result: TickResult) => void): void {
    const existing = this.tickListeners.get(userId) ?? [];
    existing.push(listener);
    this.tickListeners.set(userId, existing);
  }

  removeTickListener(userId: string, listener: (result: TickResult) => void): void {
    const existing = this.tickListeners.get(userId) ?? [];
    this.tickListeners.set(
      userId,
      existing.filter((l) => l !== listener),
    );
  }

  async stopAll(): Promise<void> {
    const userIds = this.getActiveUserIds();
    for (const userId of userIds) {
      await this.stopUser(userId);
    }
  }

  async getTrades(userId: string, date?: string): Promise<any[]> {
    const d = date || new Date().toISOString().slice(0, 10);
    const raw = await this.cache.getClient().lrange(`trades:${userId}:${d}`, 0, -1);
    return raw.map(r => JSON.parse(r));
  }
}
