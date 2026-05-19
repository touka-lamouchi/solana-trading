/**
 * CycleSimulator unit tests. Run: npx ts-node tests/unit/test_cycle_simulator.ts
 */

import type { PoolEdge } from "../../src/layer1_opportunity/pure_code/token_graph";
import { simulateCycle, swapAmount } from "../../src/layer1_opportunity/pure_code/cycle_simulator";

function assert(cond: any, msg: string): void {
  if (!cond) throw new Error("assertion failed: " + msg);
}

function approxEq(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) < eps;
}

function edge(from: string, to: string, reserveIn: number, reserveOut: number): PoolEdge {
  return {
    poolKey: `${from}-${to}`,
    fromMint: from, toMint: to,
    reserveIn, reserveOut,
    feeNumerator: 997, feeDenominator: 1000,
    decimalsIn: 6, decimalsOut: 6,
  };
}

function testSwapAmountConstantProduct() {
  // x*y=k with 0.3% fee:
  // amountInWithFee = 100 * 997 = 99700
  // num = 99700 * 1000 = 99,700,000
  // den = 1000*1000 + 99700 = 1,099,700
  // out = ~90.661
  const out = swapAmount(100, edge("A", "B", 1000, 1000));
  assert(approxEq(out, 99_700_000 / 1_099_700, 1e-6), `out=${out}`);
}

function testSwapAmountZeroOnEmptyPool() {
  assert(swapAmount(100, edge("A", "B", 0, 1000)) === 0, "zero in reserve");
  assert(swapAmount(100, edge("A", "B", 1000, 0)) === 0, "zero out reserve");
  assert(swapAmount(0, edge("A", "B", 1000, 1000)) === 0, "zero amount");
  assert(swapAmount(-1, edge("A", "B", 1000, 1000)) === 0, "negative amount");
}

function testSimulateCycleHappyPath() {
  // Construct a 3-hop cycle that returns more than amountIn:
  // Same pools but second pool has imbalanced reserves favoring our path.
  const c: PoolEdge[] = [
    edge("USDC", "SOL", 1000, 10),
    edge("SOL", "RAY", 5, 600),       // imbalance
    edge("RAY", "USDC", 1000, 1100),  // gives back more USDC
  ];
  const sim = simulateCycle(c, 100);
  assert(sim !== null, "simulation must succeed");
  assert(sim!.steps.length === 3, "3 steps");
  assert(sim!.amountIn === 100, "amountIn echoes input");
  // We don't assert exact value, just that math chains and grossProfit makes sense
  assert(sim!.amountOut > 0, "amountOut > 0");
  assert(approxEq(sim!.grossProfit, sim!.amountOut - 100), "profit math");
}

function testSimulateCycleRejectsBrokenChain() {
  const broken: PoolEdge[] = [
    edge("A", "B", 100, 100),
    edge("X", "A", 100, 100), // doesn't chain
  ];
  assert(simulateCycle(broken, 10) === null, "broken chain rejected");
}

function testSimulateCycleRejectsNonClosed() {
  const open: PoolEdge[] = [
    edge("A", "B", 100, 100),
    edge("B", "C", 100, 100), // ends at C not A
  ];
  assert(simulateCycle(open, 10) === null, "open cycle rejected");
}

function testSimulateCycleRejectsTooShort() {
  assert(simulateCycle([], 10) === null, "empty rejected");
  assert(simulateCycle([edge("A", "A", 1, 1)], 10) === null, "single-hop rejected");
}

function testSimulateCycleProfitablePathExists() {
  // Build a 3-cycle that we know has a closed-loop arbitrage.
  // Pool1 USDC/SOL @ 100/1, Pool2 SOL/RAY @ 1/100, Pool3 RAY/USDC @ 100/110.
  // 100 USDC -> ~0.99 SOL -> ~99 RAY -> ~108 USDC. Profit ~8.
  const c: PoolEdge[] = [
    edge("USDC", "SOL", 100, 1),
    edge("SOL", "RAY", 1, 100),
    edge("RAY", "USDC", 100, 110),
  ];
  const sim = simulateCycle(c, 1)!;
  assert(sim.grossProfit > 0, `profit should be > 0, got ${sim.grossProfit}`);
}

const tests: Array<[string, () => void]> = [
  ["swapAmount: constant product with fee", testSwapAmountConstantProduct],
  ["swapAmount: zero on empty pool / bad input", testSwapAmountZeroOnEmptyPool],
  ["simulateCycle: 3-hop chains correctly", testSimulateCycleHappyPath],
  ["simulateCycle: rejects broken chain", testSimulateCycleRejectsBrokenChain],
  ["simulateCycle: rejects non-closed cycle", testSimulateCycleRejectsNonClosed],
  ["simulateCycle: rejects too short", testSimulateCycleRejectsTooShort],
  ["simulateCycle: profitable path produces gross profit", testSimulateCycleProfitablePathExists],
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
console.log(`\n${passed}/${tests.length} CycleSimulator tests passed`);
