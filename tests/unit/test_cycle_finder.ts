/**
 * CycleFinder unit tests. Run: npx ts-node tests/unit/test_cycle_finder.ts
 */

import { TokenGraph } from "../../src/layer1_opportunity/pure_code/token_graph";
import { findCycles } from "../../src/layer1_opportunity/pure_code/cycle_finder";

function assert(cond: any, msg: string): void {
  if (!cond) throw new Error("assertion failed: " + msg);
}

function makeTriangle(): TokenGraph {
  const g = new TokenGraph();
  g.upsertPool({
    poolKey: "P1", mintA: "USDC", mintB: "SOL",
    reserveA: 1000, reserveB: 10,
    feeNumerator: 997, feeDenominator: 1000,
    decimalsA: 6, decimalsB: 9,
  });
  g.upsertPool({
    poolKey: "P2", mintA: "SOL", mintB: "RAY",
    reserveA: 5, reserveB: 500,
    feeNumerator: 997, feeDenominator: 1000,
    decimalsA: 9, decimalsB: 6,
  });
  g.upsertPool({
    poolKey: "P3", mintA: "USDC", mintB: "RAY",
    reserveA: 800, reserveB: 1000,
    feeNumerator: 997, feeDenominator: 1000,
    decimalsA: 6, decimalsB: 6,
  });
  return g;
}

function testTriangleProducesTwoDirections() {
  const g = makeTriangle();
  const cycles = findCycles(g, "USDC", { minDepth: 2, maxDepth: 4 });
  // Triangle USDC↔SOL↔RAY↔USDC: should find both directions, length 3.
  const triangles = cycles.filter(c => c.length === 3);
  assert(triangles.length === 2, `expected 2 triangles, got ${triangles.length}`);
  // First hop must start at USDC.
  for (const c of triangles) assert(c[0]!.fromMint === "USDC", "starts at USDC");
  // Last hop must return to USDC.
  for (const c of triangles) assert(c[c.length - 1]!.toMint === "USDC", "returns to USDC");
}

function testNoTwoHopCyclesInTriangle() {
  // No pool connects USDC to itself, so depth 2 yields nothing.
  const g = makeTriangle();
  const cycles = findCycles(g, "USDC", { minDepth: 2, maxDepth: 2 });
  assert(cycles.length === 0, `expected 0 two-hop cycles, got ${cycles.length}`);
}

function testParallelPoolsProduceTwoHopCycle() {
  // Two pools both for USDC/SOL — borrow USDC, swap on P1, swap back on P2.
  const g = new TokenGraph();
  g.upsertPool({
    poolKey: "P1", mintA: "USDC", mintB: "SOL",
    reserveA: 1000, reserveB: 10,
    feeNumerator: 997, feeDenominator: 1000,
    decimalsA: 6, decimalsB: 9,
  });
  g.upsertPool({
    poolKey: "P2", mintA: "USDC", mintB: "SOL",
    reserveA: 1100, reserveB: 9,
    feeNumerator: 997, feeDenominator: 1000,
    decimalsA: 6, decimalsB: 9,
  });
  const cycles = findCycles(g, "USDC", { minDepth: 2, maxDepth: 2 });
  // Both directions: USDC→SOL via P1 then SOL→USDC via P2, and the reverse.
  assert(cycles.length === 2, `expected 2 two-hop cycles, got ${cycles.length}`);
  for (const c of cycles) {
    assert(c.length === 2, "length 2");
    assert(c[0]!.poolKey !== c[1]!.poolKey, "different pools each hop");
  }
}

function testNoEdgeCyclesWhenIsolated() {
  const g = new TokenGraph();
  g.upsertPool({
    poolKey: "P1", mintA: "X", mintB: "Y",
    reserveA: 100, reserveB: 100,
    feeNumerator: 997, feeDenominator: 1000,
    decimalsA: 6, decimalsB: 6,
  });
  assert(findCycles(g, "USDC").length === 0, "no cycles from absent token");
  assert(findCycles(g, "X", { minDepth: 2, maxDepth: 4 }).length === 0,
    "no cycles when no return path");
}

function testMaxDepthRespected() {
  const g = makeTriangle();
  const cycles = findCycles(g, "USDC", { minDepth: 2, maxDepth: 3 });
  for (const c of cycles) assert(c.length <= 3, `cycle of length ${c.length}`);
}

function testMaxCyclesCap() {
  const g = makeTriangle();
  const cycles = findCycles(g, "USDC", { minDepth: 2, maxDepth: 4, maxCycles: 1 });
  assert(cycles.length === 1, `cap honored: got ${cycles.length}`);
}

const tests: Array<[string, () => void]> = [
  ["triangle yields both traversal directions", testTriangleProducesTwoDirections],
  ["no two-hop cycles in triangle (no parallel pools)", testNoTwoHopCyclesInTriangle],
  ["two parallel pools produce two-hop cycle", testParallelPoolsProduceTwoHopCycle],
  ["no cycles when token disconnected", testNoEdgeCyclesWhenIsolated],
  ["maxDepth respected", testMaxDepthRespected],
  ["maxCycles cap honored", testMaxCyclesCap],
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
console.log(`\n${passed}/${tests.length} CycleFinder tests passed`);
