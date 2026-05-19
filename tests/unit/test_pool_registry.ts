/**
 * PoolRegistry unit tests. Run: npx ts-node tests/unit/test_pool_registry.ts
 */

import { PoolRegistry } from "../../src/layer1_opportunity/pure_code/pool_registry";

function assert(cond: any, msg: string): void {
  if (!cond) throw new Error("assertion failed: " + msg);
}

function rec(key: string, ts = 0): any {
  return {
    poolKey: key,
    mintA: "A", mintB: "B",
    vaultA: "VA", vaultB: "VB",
    reserveA: 100, reserveB: 100,
    feeNumerator: 997, feeDenominator: 1000,
    decimalsA: 6, decimalsB: 6,
    updatedAt: ts,
  };
}

function testUpsertAndGet() {
  const r = new PoolRegistry();
  r.upsert(rec("P1", 100));
  assert(r.size() === 1, "size 1");
  assert(r.has("P1"), "has P1");
  const got = r.get("P1")!;
  assert(got.poolKey === "P1", "key");
  assert(got.reserveA === 100, "reserveA");
}

function testUpdateReserves() {
  const r = new PoolRegistry();
  r.upsert(rec("P1", 100));
  r.updateReserves("P1", 200, 300, 555);
  const p = r.get("P1")!;
  assert(p.reserveA === 200 && p.reserveB === 300, "reserves updated");
  assert(p.updatedAt === 555, "ts updated");
}

function testUpdateMissingNoOp() {
  const r = new PoolRegistry();
  r.updateReserves("UNKNOWN", 1, 2);
  assert(r.size() === 0, "still empty");
}

function testStaleFiltering() {
  const r = new PoolRegistry();
  r.upsert(rec("FRESH", 1000));
  r.upsert(rec("OLD", 100));
  const stale = r.stale(100, 1100); // anything older than 1000 ms ago
  const keys = stale.map(p => p.poolKey).sort();
  assert(keys.length === 1 && keys[0] === "OLD", `expected only OLD; got ${keys}`);
}

function testRemove() {
  const r = new PoolRegistry();
  r.upsert(rec("P1"));
  r.upsert(rec("P2"));
  r.remove("P1");
  assert(!r.has("P1"), "P1 gone");
  assert(r.has("P2"), "P2 stays");
}

const tests: Array<[string, () => void]> = [
  ["upsert + get", testUpsertAndGet],
  ["updateReserves", testUpdateReserves],
  ["update on unknown is no-op", testUpdateMissingNoOp],
  ["stale filter", testStaleFiltering],
  ["remove", testRemove],
];

let passed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e: any) {
    console.error(`  ✗ ${name}: ${e.message}`);
    process.exit(1);
  }
}
console.log(`\n${passed}/${tests.length} PoolRegistry tests passed`);
