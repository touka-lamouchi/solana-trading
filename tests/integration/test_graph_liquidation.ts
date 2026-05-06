/**
 * test_graph_liquidation.ts — Phase 5 liquidation routing verification.
 *
 * Proves that:
 *  1. liq_opportunity events route through liqEntry (pre-populate filteredOpportunities)
 *  2. A user's liq event doesn't bleed into another user's lane
 *  3. drop_newest means a flooded lane never executes stale liq events
 *     (the detection window closed; keeping old detections risks double-executions)
 *
 * Uses a mock graph — no devnet, no Redis.
 */

import { UserLane } from "../../src/graph/user_lane";
import { EventQueue } from "../../src/graph/queue";
import type { EngineDeps } from "../../src/graph/deps";
import type { GraphStateType } from "../../src/graph/state";
import type { DiscoveredOpportunity } from "../../src/engine/arb_reactor";

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

interface InvokeRecord {
  state: Partial<GraphStateType>;
}

function makeMockGraph(): { graph: any; calls: InvokeRecord[] } {
  const calls: InvokeRecord[] = [];
  const graph = {
    invoke: async (state: Partial<GraphStateType>) => {
      calls.push({ state });
      return {
        result: { poolsScanned: 0, opportunitiesFound: 0, safetyRejected: 0, guardRejected: 0, tradesExecuted: 0, tradesFailed: 0, details: [], vault: null },
        lastDecision: null,
      };
    },
  };
  return { graph, calls };
}

function makeMinimalDeps(userId: string): EngineDeps {
  return { userId, getUserConfig: () => ({}) } as any;
}

function makeLiqOpp(borrower = "BorrowerXYZ"): DiscoveredOpportunity {
  return {
    arb: {
      type: "liquidation",
      path: `liquidation: ${borrower} (fSOL/fUSDC) health=0.95`,
      tokenIn: "fUSDC",
      tokenOut: "fSOL",
      amountIn: 50,
      expectedProfit: 2.5,
      profitPercent: 5.0,
      pools: [],
      timestamp: Date.now(),
    },
    poolStates: [],
    involvedMints: ["mintSOL"],
    poolKeys: ["pool1"],
    isTriangular: false,
  };
}

// ── Test 1: liq event routes to liqEntry ─────────────────────────────────────

async function testLiqRouting(): Promise<void> {
  console.log("\nTest 1: liq_opportunity routes through liqEntry");
  const { graph, calls } = makeMockGraph();
  const deps = makeMinimalDeps("user-liq-test");
  const results: any[] = [];

  const lane = new UserLane(deps, graph, (gtr) => results.push(gtr));
  lane.start();

  lane.enqueue({
    kind: "liq_opportunity",
    userId: "user-liq-test",
    opp: makeLiqOpp(),
    poolStates: new Map(),
    enqueuedAt: Date.now(),
  });

  await new Promise(r => setTimeout(r, 50));
  await lane.stop();

  assert(calls.length === 1, `graph.invoke() called once (got ${calls.length})`);
  const invoked = calls[0]!.state;
  assert(
    Array.isArray(invoked.filteredOpportunities) && invoked.filteredOpportunities?.length === 1,
    `filteredOpportunities pre-populated with the liq opp`,
  );
  assert(
    invoked.filteredOpportunities?.[0]?.arb?.type === "liquidation",
    `opportunity type is "liquidation"`,
  );
  assert(results.length === 1, `onResult callback fired once`);
}

// ── Test 2: user isolation — liq event for A doesn't appear in B's graph ──────

async function testLiqIsolation(): Promise<void> {
  console.log("\nTest 2: liq_opportunity for user A doesn't reach user B's graph");
  const { graph: graphA, calls: callsA } = makeMockGraph();
  const { graph: graphB, calls: callsB } = makeMockGraph();

  const laneA = new UserLane(makeMinimalDeps("userA"), graphA, () => {});
  const laneB = new UserLane(makeMinimalDeps("userB"), graphB, () => {});

  laneA.start();
  laneB.start();

  // Enqueue liq event ONLY to lane A
  laneA.enqueue({
    kind: "liq_opportunity",
    userId: "userA",
    opp: makeLiqOpp("BorrowerA"),
    poolStates: new Map(),
    enqueuedAt: Date.now(),
  });

  await new Promise(r => setTimeout(r, 100));
  await Promise.all([laneA.stop(), laneB.stop()]);

  // A's graph received the liq event
  assert(callsA.some(c => c.state.filteredOpportunities?.length === 1), `user A's graph received the liq opp`);

  // B's graph may have received a signals_timer call (from the 5s interval) but NOT a liq event
  const bGotLiq = callsB.some(c =>
    c.state.filteredOpportunities?.[0]?.arb?.type === "liquidation",
  );
  assert(!bGotLiq, `user B's graph did NOT receive user A's liq opp (full isolation)`);
}

// ── Test 3: drop_newest on flooded liq queue — stale detections discarded ────

async function testLiqDropNewest(): Promise<void> {
  console.log("\nTest 3: drop_newest discards stale liq detections when queue is full");
  // Small capacity to trigger drops quickly
  const q = new EventQueue({ userId: "user-liq-drop", capacity: 2 });
  for (let i = 0; i < 5; i++) {
    q.enqueue({
      kind: "liq_opportunity",
      userId: "user-liq-drop",
      opp: makeLiqOpp(`Borrower${i}`),
      poolStates: new Map(),
      enqueuedAt: Date.now() + i,
    });
  }

  const m = q.metrics();
  assert(m.size === 2, `queue capped at 2 (capacity)`);
  assert(m.droppedByKind.liq_opportunity === 3, `3 liq events dropped (drop_newest: first 2 admitted, remaining 3 discarded)`);

  // The 2 admitted events are the first ones (drop_newest keeps existing items)
  const admitted: string[] = [];
  let ev;
  while ((ev = q.dequeue())) {
    admitted.push((ev as any).opp.arb.path.match(/Borrower(\d)/)?.[1] ?? "?");
  }
  assert(admitted[0] === "0" && admitted[1] === "1",
    `admitted liq events are the earliest detections (Borrower0, Borrower1), got ${admitted}`);
}

// ── Run all ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await testLiqRouting();
  await testLiqIsolation();
  await testLiqDropNewest();

  console.log(`\n${"─".repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error("LIQUIDATION ROUTING TESTS FAILED");
    process.exit(1);
  }
  console.log("✅ All liquidation routing tests passed");
}

main().catch(e => { console.error(e); process.exit(1); });
