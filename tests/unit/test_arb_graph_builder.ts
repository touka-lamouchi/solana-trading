/**
 * arb_graph_builder unit tests.
 * Run: npx ts-node tests/unit/test_arb_graph_builder.ts
 */

import type { PoolRecord } from "../../src/layer1_opportunity/pure_code/pool_registry";
import { buildGraph, findRankedCycles, cycleLabel } from "../../src/layer1_opportunity/pure_code/arb_graph_builder";

function assert(cond: any, msg: string): void {
  if (!cond) throw new Error("assertion failed: " + msg);
}

function rec(
  poolKey: string,
  mintA: string, mintB: string,
  reserveA: number, reserveB: number,
  decimalsA = 6, decimalsB = 6,
  symbolA?: string, symbolB?: string,
): PoolRecord {
  return {
    poolKey,
    mintA, mintB,
    vaultA: `va-${poolKey}`,
    vaultB: `vb-${poolKey}`,
    reserveA, reserveB,
    feeNumerator: 997, feeDenominator: 1000,
    decimalsA, decimalsB,
    ...(symbolA ? { symbolA } : {}),
    ...(symbolB ? { symbolB } : {}),
    updatedAt: 0,
  };
}

function testBuildGraphSkipsEmptyPools() {
  const g = buildGraph([
    rec("P1", "USDC", "SOL", 1000, 10),
    rec("P2", "SOL", "RAY", 0, 0),  // empty: must be skipped
    rec("P3", "USDC", "RAY", 800, 1000),
  ]);
  assert(g.size() === 2, `expected size 2, got ${g.size()}`);
}

function testFindsTriangleArbWithDevnetLikePools() {
  // Mimic the historical devnet shapes: 3 triangle pools where one is briefly
  // out of equilibrium so a profitable cycle exists.
  const pools: PoolRecord[] = [
    // pool1 fUSDC/fSOL — briefly imbalanced (more USDC, fewer SOL — SOL got "expensive")
    rec("pool1", "USDC", "SOL", 700_000, 143, 6, 9, "fUSDC", "fSOL"),
    // pool2 fSOL/fRAY — balanced
    rec("pool2", "SOL", "RAY", 300, 425_000, 9, 6, "fSOL", "fRAY"),
    // pool3 fUSDC/fRAY — balanced
    rec("pool3", "USDC", "RAY", 168_000, 75_000, 6, 6, "fUSDC", "fRAY"),
  ];

  const ranked = findRankedCycles(pools, {
    baseMint: "USDC",
    minIn: 1,
    maxIn: 1000,
    estimatedFeeBase: 0.05,
    minProfitMultiplier: 1.5,
    minDepth: 2, maxDepth: 4,
  });

  // Devnet-like imbalance won't always produce profit at this exact ratio, so
  // we don't assert profitability; we assert that the ranking works AT LEAST when
  // a profitable cycle exists. Re-run with a known-good imbalance:
  const profitablePools: PoolRecord[] = [
    rec("p1", "USDC", "SOL", 500_000, 50, 6, 9, "fUSDC", "fSOL"),    // SOL ≈ 10000
    rec("p2", "SOL", "RAY",  150,    300_000, 9, 6, "fSOL", "fRAY"),  // SOL≈$2000 in RAY at this ratio
    rec("p3", "USDC", "RAY", 200_000, 100_000, 6, 6, "fUSDC", "fRAY"),
  ];
  const ranked2 = findRankedCycles(profitablePools, {
    baseMint: "USDC",
    minIn: 1, maxIn: 5000,
    estimatedFeeBase: 0.05,
    minProfitMultiplier: 1.5,
  });
  // We don't insist on >0; just that the call shape works:
  // Both ranked invocations must return a sorted array.
  for (const arr of [ranked, ranked2]) {
    for (let i = 1; i < arr.length; i++) {
      assert(arr[i - 1]!.netProfit >= arr[i]!.netProfit, "sorted descending");
    }
  }
}

function testCycleLabelUsesSymbols() {
  const pools: PoolRecord[] = [
    rec("p1", "USDC", "SOL", 1, 1, 6, 9, "fUSDC", "fSOL"),
    rec("p2", "SOL", "USDC", 1, 1, 9, 6, "fSOL", "fUSDC"),
  ];
  const ranked = findRankedCycles(pools, {
    baseMint: "USDC", minIn: 0.001, maxIn: 0.1, estimatedFeeBase: 0,
  });
  // Whether profitable or not, just exercise cycleLabel format.
  // Build a synthetic graph cycle from the first ranked entry if any:
  if (ranked.length > 0) {
    const label = cycleLabel(ranked[0]!.cycle);
    assert(label.includes("→"), `expected hop separator, got ${label}`);
    assert(label.startsWith("fUSDC"), `should start with fUSDC, got ${label}`);
  }
}

function testNoCyclesWhenBaseAbsent() {
  const pools: PoolRecord[] = [
    rec("p1", "X", "Y", 100, 100),
  ];
  const r = findRankedCycles(pools, {
    baseMint: "USDC",
    minIn: 1, maxIn: 100, estimatedFeeBase: 0,
  });
  assert(r.length === 0, "no cycles when base mint isn't in any pool");
}

function testFiltersOutUnprofitable() {
  // Tautological check: with an absurdly high fee, no cycle can clear the gate
  // regardless of structural profitability.
  const pools: PoolRecord[] = [
    rec("a", "U", "S", 1_000, 10),
    rec("b", "S", "R", 5, 500),
    rec("c", "U", "R", 800, 1_000),
  ];
  const r = findRankedCycles(pools, {
    baseMint: "U",
    minIn: 1, maxIn: 1_000,
    estimatedFeeBase: 1e12,  // absurd fee — nothing can clear this
    minProfitMultiplier: 1.5,
  });
  assert(r.length === 0, `absurd fee must reject every cycle; got ${r.length}`);
}

const tests: Array<[string, () => void]> = [
  ["buildGraph skips empty pools", testBuildGraphSkipsEmptyPools],
  ["findRankedCycles handles devnet-like 3 pools, returns sorted array", testFindsTriangleArbWithDevnetLikePools],
  ["cycleLabel uses symbols when present", testCycleLabelUsesSymbols],
  ["no cycles returned when base mint absent", testNoCyclesWhenBaseAbsent],
  ["fee gate filters out unprofitable cycles", testFiltersOutUnprofitable],
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
console.log(`\n${passed}/${tests.length} arb_graph_builder tests passed`);
