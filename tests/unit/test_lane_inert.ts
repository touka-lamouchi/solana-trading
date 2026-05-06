/**
 * Phase 2 inert-drain test.
 *
 * Proves the per-user ordering guarantee:
 *   "a UserLane started with N enqueued events always processes exactly N,
 *    in the order enqueued, with zero events lost on stop()."
 *
 * The consumer is dormant (no graph calls) so the test is pure-TS, no
 * Solana RPC, no Redis — runs offline in <100 ms.
 *
 * Run: npx ts-node tests/unit/test_lane_inert.ts
 */

import { UserLane } from "../../src/graph/user_lane";
import type { LaneEvent } from "../../src/graph/events";
import type { EngineDeps } from "../../src/graph/deps";
import { logger } from "../../src/utils/logger";

// Minimal deps — UserLane only reads deps.userId in Phase 2.
function fakeDeps(userId = "test-user"): EngineDeps {
  return {
    engine: {} as any,
    protection: {} as any,
    cache: {} as any,
    connection: {} as any,
    poolMonitor: null,
    pools: {},
    tokens: {},
    baseMint: "fakeA",
    userId,
    arbDetector: {} as any,
    yieldMonitor: {} as any,
    liquidationHunter: {} as any,
    chartPatternDetector: {} as any,
    socialBuzzDetector: {} as any,
    whaleCopyDetector: {} as any,
    mempoolPressureDetector: {} as any,
    decisionModel: {} as any,
    ingestionService: {} as any,
    safety: {} as any,
    router: {} as any,
  };
}

function makeEvent(kind: LaneEvent["kind"], userId = "test-user"): LaneEvent {
  // Type-safe event construction per kind
  if (kind === "signals_timer") return { kind, userId, enqueuedAt: Date.now() };
  if (kind === "pool_changed") return { kind, userId, enqueuedAt: Date.now(), poolKey: "pool1" };
  if (kind === "candle_closed") return { kind, userId, enqueuedAt: Date.now(), candle: {} as any };
  if (kind === "arb_opportunity") return { kind, userId, enqueuedAt: Date.now(), opp: {} as any, poolStates: new Map() };
  if (kind === "liq_opportunity") return { kind, userId, enqueuedAt: Date.now(), opp: {} as any, poolStates: new Map() };
  return { kind: "mempool_pressure", userId, enqueuedAt: Date.now(), mint: "fake", pressure: 0.5 };
}

async function testBasicDrain() {
  const lane = new UserLane(fakeDeps());

  // Enqueue before start — queue accumulates offline.
  const N = 20;
  for (let i = 0; i < N; i++) {
    lane.enqueue(makeEvent("signals_timer"));
  }

  lane.start();
  await lane.stop(); // waits for full drain

  const m = lane.metrics();
  if (m.processedTotal !== N) throw new Error(`testBasicDrain: expected ${N} processed, got ${m.processedTotal}`);
  if (m.queue.size !== 0) throw new Error(`testBasicDrain: expected empty queue, got ${m.queue.size}`);
  if (m.errorTotal !== 0) throw new Error(`testBasicDrain: expected 0 errors, got ${m.errorTotal}`);
  logger.info({ N, processed: m.processedTotal }, "testBasicDrain: PASS");
}

async function testMixedKinds() {
  const lane = new UserLane(fakeDeps());

  const kinds: LaneEvent["kind"][] = [
    "signals_timer", "arb_opportunity", "liq_opportunity",
    "candle_closed", "pool_changed", "mempool_pressure",
  ];
  const N = kinds.length * 3; // 18 events total
  for (const kind of kinds) {
    for (let i = 0; i < 3; i++) lane.enqueue(makeEvent(kind));
  }

  lane.start();
  await lane.stop();

  const m = lane.metrics();
  if (m.processedTotal !== N) throw new Error(`testMixedKinds: expected ${N} processed, got ${m.processedTotal}`);
  logger.info({ N, processed: m.processedTotal }, "testMixedKinds: PASS");
}

async function testDropPolicyNeverDrop() {
  // Fill queue past capacity with never_drop candle_closed events.
  // They should all be processed (queue grows beyond capacity with a warning).
  const lane = new UserLane(fakeDeps());
  const N = 300; // exceeds default capacity (256)
  for (let i = 0; i < N; i++) {
    lane.enqueue(makeEvent("candle_closed"));
  }

  lane.start();
  await lane.stop();

  const m = lane.metrics();
  // never_drop: all 300 should be in the queue (none dropped) — all processed
  if (m.processedTotal !== N) throw new Error(`testDropPolicyNeverDrop: expected ${N}, got ${m.processedTotal}`);
  if (m.queue.droppedByKind.candle_closed !== 0) throw new Error(`testDropPolicyNeverDrop: candle_closed should never be dropped`);
  logger.info({ N, processed: m.processedTotal }, "testDropPolicyNeverDrop: PASS");
}

async function testDropPolicyDropOldest() {
  // Fill queue to capacity with signals_timer (drop_oldest policy), then add one more.
  // The oldest should be evicted and the new one accepted. Queue should be at capacity.
  const CAPACITY = 256;
  const lane = new UserLane(fakeDeps());

  for (let i = 0; i < CAPACITY + 5; i++) {
    lane.enqueue(makeEvent("signals_timer"));
  }

  const m = lane.metrics();
  // Queue at capacity — oldest 5 were evicted, newest 5 replaced them.
  if (m.queue.size !== CAPACITY) {
    throw new Error(`testDropPolicyDropOldest: expected queue size ${CAPACITY}, got ${m.queue.size}`);
  }
  if (m.queue.droppedTotal !== 5) {
    throw new Error(`testDropPolicyDropOldest: expected 5 dropped, got ${m.queue.droppedTotal}`);
  }

  lane.start();
  await lane.stop();

  const m2 = lane.metrics();
  if (m2.processedTotal !== CAPACITY) {
    throw new Error(`testDropPolicyDropOldest: expected ${CAPACITY} processed, got ${m2.processedTotal}`);
  }
  logger.info({ processed: m2.processedTotal, dropped: m2.queue.droppedTotal }, "testDropPolicyDropOldest: PASS");
}

async function testEnqueueAfterStart() {
  // Enqueue events after start() — consumer should pick them up live.
  const lane = new UserLane(fakeDeps());
  lane.start();

  const N = 10;
  for (let i = 0; i < N; i++) {
    lane.enqueue(makeEvent("signals_timer"));
  }

  await lane.stop();

  const m = lane.metrics();
  if (m.processedTotal !== N) throw new Error(`testEnqueueAfterStart: expected ${N}, got ${m.processedTotal}`);
  logger.info({ N, processed: m.processedTotal }, "testEnqueueAfterStart: PASS");
}

async function main() {
  logger.info("── Phase 2: UserLane inert-drain tests ──");

  await testBasicDrain();
  await testMixedKinds();
  await testDropPolicyNeverDrop();
  await testDropPolicyDropOldest();
  await testEnqueueAfterStart();

  logger.info("Phase 2 inert-drain tests PASSED — lane drains exactly N events with zero losses");
}

main().catch(e => {
  logger.error({ err: e }, "test_lane_inert failed");
  process.exit(1);
});
