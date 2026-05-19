/**
 * TokenGraph unit tests. Pure logic, no Solana, no fixtures.
 * Run: npx ts-node tests/unit/test_token_graph.ts
 */

import { TokenGraph } from "../../src/layer1_opportunity/pure_code/token_graph";

function assert(cond: any, msg: string): void {
  if (!cond) throw new Error("assertion failed: " + msg);
}

function eqSet<T>(a: T[], b: T[]): boolean {
  return a.length === b.length && new Set(a).size === a.length && a.every(x => b.includes(x));
}

function makeGraph() {
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

function testUpsertProducesBidirectionalEdges() {
  const g = makeGraph();
  assert(g.size() === 3, "size should be 3");
  const fromUSDC = g.edgesFrom("USDC").map(e => e.toMint);
  assert(eqSet(fromUSDC, ["SOL", "RAY"]), `USDC edges: ${fromUSDC}`);
  const fromSOL = g.edgesFrom("SOL").map(e => e.toMint);
  assert(eqSet(fromSOL, ["USDC", "RAY"]), `SOL edges: ${fromSOL}`);
  const fromRAY = g.edgesFrom("RAY").map(e => e.toMint);
  assert(eqSet(fromRAY, ["SOL", "USDC"]), `RAY edges: ${fromRAY}`);
}

function testUpsertReplacesExisting() {
  const g = makeGraph();
  g.upsertPool({
    poolKey: "P1", mintA: "USDC", mintB: "SOL",
    reserveA: 9999, reserveB: 99,
    feeNumerator: 997, feeDenominator: 1000,
    decimalsA: 6, decimalsB: 9,
  });
  assert(g.size() === 3, "still 3 pools after replacing");
  const sol = g.edgesFrom("USDC").find(e => e.toMint === "SOL")!;
  assert(sol.reserveIn === 9999, `reserveIn updated: ${sol.reserveIn}`);
  assert(sol.reserveOut === 99, `reserveOut updated: ${sol.reserveOut}`);
}

function testRemovePool() {
  const g = makeGraph();
  g.removePool("P2");
  assert(g.size() === 2, "size 2 after remove");
  assert(g.edgesFrom("SOL").length === 1, "SOL has only 1 outgoing edge now");
  assert(g.edgesFrom("RAY").length === 1, "RAY has only 1 outgoing edge now");
}

function testReserveOrientationCorrect() {
  const g = makeGraph();
  // From USDC perspective on P1: reserveIn=USDC=1000, reserveOut=SOL=10
  const fromUSDC = g.edgesFrom("USDC").find(e => e.poolKey === "P1")!;
  assert(fromUSDC.reserveIn === 1000 && fromUSDC.reserveOut === 10, "USDC→SOL reserves");
  // From SOL perspective on P1: reserveIn=SOL=10, reserveOut=USDC=1000
  const fromSOL = g.edgesFrom("SOL").find(e => e.poolKey === "P1")!;
  assert(fromSOL.reserveIn === 10 && fromSOL.reserveOut === 1000, "SOL→USDC reserves");
  // Decimals follow orientation too
  assert(fromUSDC.decimalsIn === 6 && fromUSDC.decimalsOut === 9, "USDC→SOL decimals");
  assert(fromSOL.decimalsIn === 9 && fromSOL.decimalsOut === 6, "SOL→USDC decimals");
}

const tests: Array<[string, () => void]> = [
  ["upsert produces bidirectional edges", testUpsertProducesBidirectionalEdges],
  ["upsert replaces existing pool", testUpsertReplacesExisting],
  ["remove pool", testRemovePool],
  ["reserve orientation correct per direction", testReserveOrientationCorrect],
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
console.log(`\n${passed}/${tests.length} TokenGraph tests passed`);
