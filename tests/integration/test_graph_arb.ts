/**
 * test_graph_arb.ts — Phase 5 arb routing verification.
 *
 * Proves that when an arb_opportunity event enters a UserLane, the lane
 * calls arbEntry (not signalsEntry or liqEntry), and the opportunity
 * arrives in the graph state as filteredOpportunities[0].
 *
 * Uses a mock graph that records every invoke() call and returns an empty
 * TickResult — no devnet, no Redis, no real execution.
 */

import { UserLane } from "../../src/graph/user_lane";
import type { EngineDeps } from "../../src/graph/deps";
import type { GraphStateType } from "../../src/graph/state";
import type { DiscoveredOpportunity } from "../../src/engine/arb_reactor";
import type { PoolState } from "../../src/layer1_opportunity/pure_code/arbitrage_detector";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${message}`);
    failed++;
  }
}

// ── Mock graph ────────────────────────────────────────────────────────────────

interface InvokeRecord {
  state: Partial<GraphStateType>;
}

function makeMockGraph(): { graph: any; calls: InvokeRecord[] } {
  const calls: InvokeRecord[] = [];
  const graph = {
    invoke: async (state: Partial<GraphStateType>) => {
      calls.push({ state });
      return {
        result: {
          poolsScanned: 0,
          opportunitiesFound: 0,
          safetyRejected: 0,
          guardRejected: 0,
          tradesExecuted: 0,
          tradesFailed: 0,
          details: [],
          vault: null,
        },
        lastDecision: null,
      };
    },
  };
  return { graph, calls };
}

function makeMinimalDeps(userId: string): EngineDeps {
  return { userId, getUserConfig: () => ({}) } as any;
}

function makeArbOpp(): DiscoveredOpportunity {
  return {
    arb: {
      type: "arbitrage",
      path: "pool1→pool2→pool3",
      tokenIn: "fUSDC",
      tokenOut: "fSOL",
      amountIn: 100,
      expectedProfit: 0.5,
      profitPercent: 0.5,
      pools: [],
      timestamp: Date.now(),
    },
    poolStates: [],
    involvedMints: ["mint1", "mint2"],
    poolKeys: ["pool1", "pool2", "pool3"],
    isTriangular: true,
  };
}

// ── Test 1: arb event routes to arbEntry (pre-populates filteredOpportunities) ─

async function testArbRouting(): Promise<void> {
  console.log("\nTest 1: arb_opportunity routes through arbEntry");
  const { graph, calls } = makeMockGraph();
  const deps = makeMinimalDeps("user-arb-test");
  const results: any[] = [];

  const lane = new UserLane(deps, graph, (gtr) => results.push(gtr));
  lane.start();

  const opp = makeArbOpp();
  lane.enqueue({
    kind: "arb_opportunity",
    userId: "user-arb-test",
    opp,
    poolStates: new Map<string, PoolState>(),
    enqueuedAt: Date.now(),
  });

  // Give the lane's consumer loop time to process
  await new Promise(r => setTimeout(r, 50));
  await lane.stop();

  assert(calls.length === 1, `graph.invoke() called exactly once (got ${calls.length})`);
  const invoked = calls[0]!.state;
  assert(
    Array.isArray(invoked.filteredOpportunities) && (invoked.filteredOpportunities?.length ?? 0) === 1,
    `filteredOpportunities pre-populated with the arb opp`,
  );
  assert(
    invoked.filteredOpportunities?.[0]?.arb?.type === "arbitrage",
    `opportunity type is "arbitrage"`,
  );
  assert(results.length === 1, `onResult callback fired once`);
}

// ── Test 2: signals_timer does NOT pre-populate filteredOpportunities ─────────

async function testSignalsDoesNotPrePopulate(): Promise<void> {
  console.log("\nTest 2: signals_timer does not pre-populate filteredOpportunities");
  const { graph, calls } = makeMockGraph();
  const deps = makeMinimalDeps("user-sig-test");

  const lane = new UserLane(deps, graph, () => {});
  // Don't start — manually enqueue + start so setInterval doesn't fire first
  lane.enqueue({ kind: "signals_timer", userId: "user-sig-test", enqueuedAt: Date.now() });
  lane.start();

  await new Promise(r => setTimeout(r, 50));
  // Stop quickly — we may get a second signals_timer from the setInterval; only care about first
  await lane.stop();

  assert(calls.length >= 1, `graph.invoke() called at least once`);
  const firstCall = calls[0]!.state;
  const prePopulated = firstCall.filteredOpportunities;
  // signalsEntry does NOT pass filteredOpportunities — it must be undefined or absent
  assert(
    prePopulated === undefined || prePopulated === null,
    `signals_timer does not pre-populate filteredOpportunities (got ${JSON.stringify(prePopulated)})`,
  );
}

// ── Test 3: crash in dispatch doesn't stop the lane ──────────────────────────

async function testCrashResistance(): Promise<void> {
  console.log("\nTest 3: crash in one dispatch does not stop the lane");
  let crashCount = 0;
  let successCount = 0;

  const crashGraph = {
    invoke: async (state: Partial<GraphStateType>) => {
      if (state.filteredOpportunities?.length) {
        // arb event — crash deliberately
        crashCount++;
        throw new Error("simulated graph crash");
      }
      successCount++;
      return { result: { poolsScanned: 0, opportunitiesFound: 0, safetyRejected: 0, guardRejected: 0, tradesExecuted: 0, tradesFailed: 0, details: [], vault: null }, lastDecision: null };
    },
  };

  const deps = makeMinimalDeps("user-crash-test");
  const lane = new UserLane(deps, crashGraph as any, () => {});

  // Enqueue: arb (will crash), then signal (should still process)
  lane.enqueue({ kind: "arb_opportunity", userId: "user-crash-test", opp: makeArbOpp(), poolStates: new Map(), enqueuedAt: Date.now() });
  lane.enqueue({ kind: "signals_timer", userId: "user-crash-test", enqueuedAt: Date.now() });

  lane.start();
  await new Promise(r => setTimeout(r, 100));
  await lane.stop();

  assert(crashCount === 1, `arb event triggered one graph crash`);
  assert(successCount >= 1, `signals_timer processed successfully after crash (lane kept running)`);

  const m = lane.metrics();
  assert(m.errorTotal === 1, `errorTotal = 1 (only the arb crash counted)`);
}

// ── Run all ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await testArbRouting();
  await testSignalsDoesNotPrePopulate();
  await testCrashResistance();

  console.log(`\n${"─".repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error("ARB ROUTING TESTS FAILED");
    process.exit(1);
  }
  console.log("✅ All arb routing tests passed");
}

main().catch(e => { console.error(e); process.exit(1); });
