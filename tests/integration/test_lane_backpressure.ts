/**
 * test_lane_backpressure.ts — Phase 5 queue contract verification.
 *
 * Tests:
 *  1. drop_newest: arb/liq events are dropped when the queue is full
 *  2. drop_oldest: signals_timer evicts the oldest when queue is full
 *  3. never_drop:  candle_closed grows past capacity without dropping
 *  4. isolation:   flooding user A's queue has zero effect on user B
 *
 * No devnet, no Redis, no graph — pure in-memory EventQueue logic.
 */

import { EventQueue } from "../../src/graph/queue";
import type { LaneEvent } from "../../src/graph/events";

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

function makeArb(userId: string, at = Date.now()): LaneEvent {
  return { kind: "arb_opportunity", userId, enqueuedAt: at, opp: {} as any, poolStates: new Map() };
}

function makeLiq(userId: string, at = Date.now()): LaneEvent {
  return { kind: "liq_opportunity", userId, enqueuedAt: at, opp: {} as any, poolStates: new Map() };
}

function makeSignal(userId: string, at: number): LaneEvent {
  return { kind: "signals_timer", userId, enqueuedAt: at };
}

function makeCandle(userId: string): LaneEvent {
  return { kind: "candle_closed", userId, enqueuedAt: Date.now(), candle: {} as any };
}

// ── Test 1: drop_newest — arb events ────────────────────────────────────────

console.log("\nTest 1: drop_newest policy (arb_opportunity)");
{
  const q = new EventQueue({ userId: "A", capacity: 3 });
  for (let i = 0; i < 5; i++) q.enqueue(makeArb("A"));
  const m = q.metrics();
  assert(m.size === 3, `queue size is 3 (capacity)`);
  assert(m.droppedByKind.arb_opportunity === 2, `2 incoming events dropped`);
  assert(m.droppedTotal === 2, `droppedTotal = 2`);
  assert(m.enqueuedTotal === 3, `enqueuedTotal counts only admitted events`);
}

// ── Test 2: drop_newest — liq events ────────────────────────────────────────

console.log("\nTest 2: drop_newest policy (liq_opportunity)");
{
  const q = new EventQueue({ userId: "A", capacity: 2 });
  for (let i = 0; i < 4; i++) q.enqueue(makeLiq("A"));
  const m = q.metrics();
  assert(m.size === 2, `queue size is 2 (capacity)`);
  assert(m.droppedByKind.liq_opportunity === 2, `2 liq events dropped`);
}

// ── Test 3: drop_oldest — signals_timer evicts earliest ──────────────────────

console.log("\nTest 3: drop_oldest policy (signals_timer)");
{
  const q = new EventQueue({ userId: "A", capacity: 3 });
  for (let i = 0; i < 6; i++) q.enqueue(makeSignal("A", i));
  const m = q.metrics();
  assert(m.size === 3, `queue size is 3`);
  assert(m.droppedByKind.signals_timer === 3, `3 oldest signal events evicted`);

  // Drain and verify remaining events are the newest (enqueuedAt 3, 4, 5)
  const remaining: number[] = [];
  let ev: LaneEvent | undefined;
  while ((ev = q.dequeue())) remaining.push(ev.enqueuedAt);
  assert(remaining.length === 3, `dequeued 3 events`);
  assert(remaining[0] === 3 && remaining[1] === 4 && remaining[2] === 5,
    `remaining are the 3 newest (enqueuedAt 3,4,5), got ${remaining}`);
}

// ── Test 4: never_drop — candle_closed grows past capacity ──────────────────

console.log("\nTest 4: never_drop policy (candle_closed)");
{
  const q = new EventQueue({ userId: "A", capacity: 2 });
  for (let i = 0; i < 4; i++) q.enqueue(makeCandle("A"));
  const m = q.metrics();
  assert(m.size === 4, `queue grew past capacity: size = 4`);
  assert(m.droppedByKind.candle_closed === 0, `zero candle events dropped`);
  assert(m.droppedTotal === 0, `droppedTotal = 0`);
}

// ── Test 5: user isolation — flooding A has zero effect on B ─────────────────

console.log("\nTest 5: user isolation (A flooding, B unaffected)");
{
  const qA = new EventQueue({ userId: "A", capacity: 3 });
  const qB = new EventQueue({ userId: "B", capacity: 100 });

  // Flood A with 10 arb events (capacity=3, so 7 dropped)
  for (let i = 0; i < 10; i++) qA.enqueue(makeArb("A"));

  // B receives exactly one signal event
  qB.enqueue(makeSignal("B", Date.now()));

  const mA = qA.metrics();
  const mB = qB.metrics();

  assert(mA.size === 3, `A: size = 3 (at capacity)`);
  assert(mA.droppedTotal === 7, `A: 7 events dropped`);
  assert(mB.size === 1, `B: size = 1 (unaffected)`);
  assert(mB.droppedTotal === 0, `B: 0 events dropped (isolated from A)`);
}

// ── Test 6: eviction counts against the evicted event's kind ─────────────────

console.log("\nTest 6: eviction drops counted against the evicted kind (not the incoming kind)");
{
  const q = new EventQueue({ userId: "A", capacity: 2 });
  q.enqueue(makeArb("A"));           // admitted (size=1)
  q.enqueue(makeSignal("A", 0));     // admitted (size=2)
  // Queue at capacity. Next arb → drop_newest (arb dropped, not admitted).
  q.enqueue(makeArb("A"));
  // Queue at capacity. Next signal → drop_oldest (evicts oldest = first arb).
  q.enqueue(makeSignal("A", 99));

  const m = q.metrics();
  // The incoming arb was dropped (drop_newest): arb_opportunity += 1
  // The first arb was evicted (drop_oldest when new signal arrived): arb_opportunity += 1
  // signals_timer never dropped — it's always admitted via eviction
  assert(m.droppedByKind.arb_opportunity === 2, `arb drop = 2 (1 incoming drop + 1 evicted)`);
  assert(m.droppedByKind.signals_timer === 0, `signals_timer never dropped — eviction admitted it`);
  assert(m.size === 2, `queue still at capacity`);
}

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("BACKPRESSURE TESTS FAILED");
  process.exit(1);
}
console.log("✅ All backpressure tests passed — queue contract holds");
