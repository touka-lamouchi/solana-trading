/**
 * EngineDeps — the single object every graph node receives.
 *
 * Contains per-user state (engine, protection), shared infrastructure
 * (cache, connection, poolMonitor), config (pools, tokens, baseMint), and
 * individual detector/service instances (option b: pass each detector
 * directly so nodes never need a real TradingEngine in tests — inject fakes
 * freely at construction time).
 *
 * UserRegistry builds this via `engine.exposeDetectors()` + other fields.
 * Why a single bag instead of separate args per node: adding a dependency is
 * a one-line change here vs. a diff touching every node factory.
 */

import type { Connection } from "@solana/web3.js";
import type { TradingEngine } from "../engine/trading_engine";
import type { ProtectionManager } from "../protection/protection_manager";
import type { CacheManager } from "../cache/cache_manager";
import type { PoolMonitor } from "../infrastructure/pool_monitor";
import type { ArbitrageDetector } from "../layer1_opportunity/pure_code/arbitrage_detector";
import type { YieldRateMonitor } from "../layer1_opportunity/pure_code/yield_rate_monitor";
import type { LiquidationHunter } from "../layer1_opportunity/pure_code/liquidation_hunter";
import type { ChartPatternDetector } from "../layer1_opportunity/ai_signals/chart_pattern_detector";
import type { SocialBuzzDetector } from "../layer1_opportunity/ai_signals/social_buzz_detector";
import type { WhaleCopyDetector } from "../layer1_opportunity/ai_signals/whale_copy_detector";
import type { MempoolPressureDetector } from "../layer1_opportunity/ai_signals/mempool_pressure_detector";
import type { DecisionModel } from "../layer1_opportunity/decision_model";
import type { IngestionService } from "../ingestion/ingestion_service";
import type { SafetyPipeline } from "../layer1_opportunity/safety_filters/safety_pipeline";
import type { OpportunityRouter } from "../layer1_opportunity/opportunity_router";
import type { LendingClient } from "../layer2_execution/lending_client";

export interface EngineDeps {
  // Per-user runtime state
  engine: TradingEngine;
  protection: ProtectionManager;
  cache: CacheManager;

  // Infrastructure
  connection: Connection;
  poolMonitor: PoolMonitor | null;

  // Config objects (devnet_pools.json / devnet_tokens.json)
  pools: any;
  tokens: any;
  baseMint: string;   // fUSDC mint — trusted, never safety-checked
  userId: string;

  // ── Individual detectors (option b) ──────────────────────────────────
  // Each field is injectable in tests without needing a real TradingEngine.
  // Values come from engine.exposeDetectors() in production.
  arbDetector: ArbitrageDetector;
  yieldMonitor: YieldRateMonitor;
  liquidationHunter: LiquidationHunter;
  chartPatternDetector: ChartPatternDetector;
  socialBuzzDetector: SocialBuzzDetector;
  whaleCopyDetector: WhaleCopyDetector;
  mempoolPressureDetector: MempoolPressureDetector;
  decisionModel: DecisionModel;
  ingestionService: IngestionService;

  // ── Execution services ────────────────────────────────────────────────
  safety: SafetyPipeline;
  router: OpportunityRouter;
  lendingClient?: LendingClient;

  // ── WS broadcast (optional — absent in tests) ─────────────────────────
  // emit_status node calls this to deliver scan_complete events.
  wsEmit?: (event: any) => void;

  // Returns the latest user config; called each tick so live updates propagate.
  getUserConfig?: () => Record<string, any>;
}
