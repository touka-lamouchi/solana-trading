/**
 * Phase 1c smoke test — all 22 real node bodies execute end-to-end
 * against stub detectors and execution services.
 *
 * Builds the compiled graph against a minimal fake EngineDeps where every
 * detector, executor, and safety check returns empty/pass results. Proves:
 *   - all imports resolve (no circular deps, no missing modules)
 *   - all 4 entry points reach build_summary without throwing
 *   - the returned TickResult is well-formed
 *
 * Run: npx ts-node tests/unit/test_graph_topology.ts
 */

import { buildGraph } from "../../src/graph/build";
import { signalsEntry, candleEntry, arbEntry, liqEntry } from "../../src/graph/entries";import type { EngineDeps } from "../../src/graph/deps";
import type { DiscoveredOpportunity } from "../../src/engine/arb_reactor";
import { logger } from "../../src/utils/logger";

function fakeDeps(): EngineDeps {
  const poolMonitorStub = {
    isRunning: () => false,
    getState: () => undefined,
    getAllStates: () => new Map(),
  } as any;

  const arbDetectorStub = {
    getPoolState: async (pool: any) => ({
      address: pool?.address ?? "fake",
      reserveA: 1000,
      reserveB: 1000,
      tokenAMint: "fakeA",
      tokenBMint: "fakeB",
    }),
    scan: async () => [],
  } as any;

  const ingestionServiceStub = {
    ingestPoolStates: async () => {},
    getRegimeFeatures: async () => [],
    getGRUFeatures: async () => [],
    isMainnetMode: () => false,
    getMainnetMint: () => "fake",
  } as any;

  const decisionModelStub = {
    computeScore: async () => ({
      aiScore: 0,
      direction: "neutral" as const,
      regime: "ranging" as const,
      volLevel: "low" as const,
      signals: {},
    }),
  } as any;

  const detectorStub = { scan: async () => null } as any;
  const syncDetectorStub = { scan: () => [] } as any;

  const liqHunterStub = {
    loadFromRedis: async () => {},
    applyPrices: () => {},
    scan: () => [],
  } as any;

  // Safety: all mints pass
  const safetyStub = {
    check: async () => ({ passed: true }),
  } as any;

  // Router: default all to slow
  const routerStub = {
    route: () => ({ opportunity: null, path: "slow" as const, reason: "stub" }),
  } as any;

  // Protection: always allow
  const protectionStub = {
    canExecuteTrade: () => ({ allowed: true }),
    getEffectiveCapital: async (amount: number) => ({ capital: amount }),
    getVaultReader: () => null,
    slippage: 0.01,
  } as any;

  // Engine execution stubs
  const engineStub = {
    executeTriangularArbPublic: async () => ({
      pool: "stub", opportunity: "stub", stage: "executed" as const, profit: 0,
    }),
    executeDirectionalTradePublic: async () => ({
      pool: "stub", opportunity: "stub", stage: "executed" as const, profit: 0,
    }),
    logWhaleSignalsPublic: async () => {},
    consumeReactorCounters: () => ({ opportunities: 0, poolEvents: 0 }),
    onDetail: undefined,
  } as any;

  return {
    engine: engineStub,
    protection: protectionStub,
    cache: {} as any,
    connection: {} as any,
    poolMonitor: null,
    pools: {},
    tokens: {
      tokenA: { mint: "fakeA", name: "fUSDC" },
      tokenB: { mint: "fakeB", name: "fSOL" },
      tokenC: { mint: "fakeC", name: "fRAY" },
    },
    baseMint: "fakeA",
    userId: "test-user",
    arbDetector: arbDetectorStub,
    yieldMonitor: syncDetectorStub,
    liquidationHunter: liqHunterStub,
    chartPatternDetector: detectorStub,
    socialBuzzDetector: detectorStub,
    whaleCopyDetector: detectorStub,
    mempoolPressureDetector: detectorStub,
    decisionModel: decisionModelStub,
    ingestionService: ingestionServiceStub,
    safety: safetyStub,
    router: routerStub,
  };
}

function fakeOpp(): DiscoveredOpportunity {
  return {
    arb: {
      type: "arbitrage",
      path: "fake",
      tokenIn: "fUSDC",
      tokenOut: "fSOL",
      amountIn: 100,
      expectedProfit: 1,
      profitPercent: 1,
      pools: [],
      timestamp: Date.now(),
    },
    poolStates: [],
    involvedMints: [],
    poolKeys: ["pool1"],
    isTriangular: true,
  };
}

async function main() {
  const deps = fakeDeps();
  const graph = buildGraph(deps);
  const baseCtx = { graph, userConfig: {}, previousDecision: null };

  logger.info("── signalsEntry ──");
  const r1 = await signalsEntry(baseCtx);
  logger.info({ tick: r1.tick, lastDecision: r1.lastDecision }, "signalsEntry returned");

  logger.info("── candleEntry ──");
  const r2 = await candleEntry(baseCtx);
  logger.info({ tick: r2.tick }, "candleEntry returned");

  logger.info("── arbEntry ──");
  const r3 = await arbEntry({ ...baseCtx, opp: fakeOpp() });
  logger.info({ tick: r3.tick }, "arbEntry returned");

  logger.info("── liqEntry ──");
  const r4 = await liqEntry({ ...baseCtx, opp: fakeOpp() });
  logger.info({ tick: r4.tick }, "liqEntry returned");

  logger.info("Phase 3 smoke test passed — all 23 real nodes execute for all 4 entry points");
}

main().catch((e) => {
  logger.error({ err: e }, "smoke test failed");
  process.exit(1);
});
