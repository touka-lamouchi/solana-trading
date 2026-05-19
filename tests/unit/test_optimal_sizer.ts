/**
 * OptimalSizer unit tests. Run: npx ts-node tests/unit/test_optimal_sizer.ts
 */

import type { PoolEdge } from "../../src/layer1_opportunity/pure_code/token_graph";
import { findOptimalSize } from "../../src/layer1_opportunity/pure_code/optimal_sizer";
import { simulateCycle } from "../../src/layer1_opportunity/pure_code/cycle_simulator";

function assert(cond: any, msg: string): void {
  if (!cond) throw new Error("assertion failed: " + msg);
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

function profitableTriangle(): PoolEdge[] {
  // Same as cycle simulator's profitable test
  return [
    edge("USDC", "SOL", 100, 1),
    edge("SOL", "RAY", 1, 100),
    edge("RAY", "USDC", 100, 110),
  ];
}

function balancedTriangle(): PoolEdge[] {
  // Closed loop where prices are exactly aligned — fees make it unprofitable
  return [
    edge("USDC", "SOL", 1000, 10),
    edge("SOL", "RAY", 10, 100),
    edge("RAY", "USDC", 100, 1000),
  ];
}

function testFindsProfitableSize() {
  const r = findOptimalSize(profitableTriangle(), {
    minIn: 0.001, maxIn: 50, estimatedFeeBase: 0.01, minProfitMultiplier: 1.5,
  });
  assert(r.profitable, `should be profitable: ${JSON.stringify(r)}`);
  assert(r.amountIn > 0, "amountIn > 0");
  assert(r.netProfit > 0, "netProfit > 0");
}

function testReturnsPeak() {
  // Verify that findOptimalSize finds a value where neighboring sizes have
  // lower (or equal) net profit. We don't expect global maximum to <eps but
  // it should be at least as good as a spread of probes.
  const cycle = profitableTriangle();
  const r = findOptimalSize(cycle, { minIn: 0.001, maxIn: 50, estimatedFeeBase: 0 });
  const sim = simulateCycle(cycle, r.amountIn)!;
  // Probe at +/-20%; the optimum should not be beaten significantly.
  const lower = simulateCycle(cycle, r.amountIn * 0.8)!.grossProfit;
  const upper = simulateCycle(cycle, r.amountIn * 1.2)!.grossProfit;
  assert(sim.grossProfit + 1e-3 >= Math.max(lower, upper),
    `optimum ${sim.grossProfit} not better than neighbors (${lower}, ${upper})`);
}

function testRejectsUnprofitable() {
  const r = findOptimalSize(balancedTriangle(), {
    minIn: 0.001, maxIn: 100, estimatedFeeBase: 1.0, minProfitMultiplier: 1.5,
  });
  assert(!r.profitable, `balanced triangle should be unprofitable; got ${JSON.stringify(r)}`);
}

function testFeeMultiplierRejectsThinMargins() {
  // Profit just barely above fee — multiplier of 1.5 should reject.
  const cycle = profitableTriangle();
  const r1 = findOptimalSize(cycle, {
    minIn: 0.001, maxIn: 50, estimatedFeeBase: 0,
  });
  const grossAtOpt = r1.grossProfit;
  // Now set the fee = grossProfit * 0.9 so net is positive but less than 1.5×fee
  const fee = grossAtOpt * 0.9;
  const r2 = findOptimalSize(cycle, {
    minIn: 0.001, maxIn: 50, estimatedFeeBase: fee, minProfitMultiplier: 1.5,
  });
  assert(!r2.profitable, `should reject thin margin; got ${JSON.stringify(r2)}`);
}

function testCapsToMaxIn() {
  const cycle = profitableTriangle();
  const r = findOptimalSize(cycle, { minIn: 0.001, maxIn: 0.1, estimatedFeeBase: 0 });
  assert(r.amountIn <= 0.1 + 1e-9, `must respect maxIn; got ${r.amountIn}`);
}

const tests: Array<[string, () => void]> = [
  ["finds a profitable size", testFindsProfitableSize],
  ["returns a near-peak size", testReturnsPeak],
  ["rejects unprofitable cycle", testRejectsUnprofitable],
  ["fee multiplier rejects thin margins", testFeeMultiplierRejectsThinMargins],
  ["caps amountIn to maxIn", testCapsToMaxIn],
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
console.log(`\n${passed}/${tests.length} OptimalSizer tests passed`);
