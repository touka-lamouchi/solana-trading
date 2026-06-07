/**
 * test_arb_backtest.ts — backtest the ARBITRAGE CYCLE FINDER on real Binance data.
 *
 * What it does:
 *   1. Pull real historical SOLUSDT candles from Binance (falls back to a
 *      deterministic synthetic series if offline).
 *   2. For each candle, construct a 3-pool triangle:
 *        P1: USDC/SOL   — priced at the REAL Binance close (live market price)
 *        P2: SOL/RAY    — RAY pegged at $2 (constant)
 *        P3: RAY/USDC   — priced one candle LATE (lags P1), so when SOL moves,
 *                         the implied cross-rate is briefly inconsistent → a
 *                         real triangular arbitrage opportunity appears.
 *   3. Run the SAME pure code the live bot uses: findRankedCycles → optimal_sizer
 *      → simulateCycle. Record the best cycle's simulated net profit per candle.
 *   4. Summarize: hit rate, total/avg/max simulated profit, fee-gated rejects.
 *
 * This is an honest backtest: it never fabricates profit. Every recorded profit
 * comes from simulateCycle's exact constant-product walk. When the market is
 * calm (no price change), the lag closes and zero arbs are found — exactly what
 * the live bot would report.
 *
 * Run: npx ts-node tests/backtests/test_arb_backtest.ts
 */

import { findRankedCycles, cycleLabel, type RankedCycle } from "../../src/layer1_opportunity/pure_code/arb_graph_builder";
import type { PoolRecord } from "../../src/layer1_opportunity/pure_code/pool_registry";
import { fetchBinanceCandles, syntheticCandles, BACKTEST_END_TIME, type BTCandle } from "./binance_data";
import { Backtest, printResult } from "./harness";

// Fictional mints — only identity matters to the pure graph code.
const USDC = "USDCmint1111111111111111111111111111111111";
const SOL = "SOLmint11111111111111111111111111111111111";
const RAY = "RAYmint11111111111111111111111111111111111";
const RAY_USD = 2.0; // peg RAY at $2

// Build the 3-pool triangle for a given SOL price (P1) and a lagged SOL price (P3).
function buildTriangle(solPrice: number, laggedSolPrice: number): PoolRecord[] {
  const fee = { feeNumerator: 997, feeDenominator: 1000 };
  const dec = { decimalsA: 6, decimalsB: 6 };
  const base: Omit<PoolRecord, "poolKey" | "mintA" | "mintB" | "reserveA" | "reserveB"> = {
    vaultA: "v", vaultB: "v", ...fee, ...dec, updatedAt: Date.now(),
  };

  // Reserves are set so reserveA/reserveB == price. Use $1,000,000 of depth per side.
  const DEPTH = 1_000_000;

  // P1: USDC/SOL at the live price (USDC per SOL = solPrice)
  const p1: PoolRecord = {
    ...base, poolKey: "P1_USDC_SOL", mintA: USDC, mintB: SOL,
    symbolA: "USDC", symbolB: "SOL",
    reserveA: DEPTH, reserveB: DEPTH / solPrice,
  };
  // P2: SOL/RAY  (RAY per SOL = solPrice / RAY_USD), priced at LIVE solPrice
  const solInRay = solPrice / RAY_USD;
  const p2: PoolRecord = {
    ...base, poolKey: "P2_SOL_RAY", mintA: SOL, mintB: RAY,
    symbolA: "SOL", symbolB: "RAY",
    reserveA: DEPTH / solPrice, reserveB: DEPTH / solPrice * solInRay,
  };
  // P3: RAY/USDC — priced using the LAGGED sol price (this is the inconsistency)
  // RAY is pegged at $2 here regardless, but the depth is derived from lagged price
  // so the round-trip USDC→SOL→RAY→USDC doesn't exactly close to 1 when sol moves.
  const p3: PoolRecord = {
    ...base, poolKey: "P3_RAY_USDC", mintA: RAY, mintB: USDC,
    symbolA: "RAY", symbolB: "USDC",
    // RAY per USDC implied by the LAGGED price path:
    reserveA: DEPTH / RAY_USD * (solPrice / laggedSolPrice),
    reserveB: DEPTH,
  };
  return [p1, p2, p3];
}

interface ArbDecision {
  index: number;
  found: boolean;
  label?: string;
  amountIn?: number;
  netProfit?: number;
}

async function loadCandles(): Promise<{ candles: BTCandle[]; source: string }> {
  try {
    const candles = await fetchBinanceCandles("SOLUSDT", "1h", 200, BACKTEST_END_TIME);
    if (candles.length > 10) return { candles, source: "Binance SOLUSDT 1h (real)" };
  } catch (e: any) {
    console.log(`  [!] Binance fetch failed (${e.message}); using synthetic fallback.`);
  }
  return { candles: syntheticCandles(200), source: "synthetic fallback" };
}

async function main() {
  console.log("\n=== Arbitrage Cycle-Finder Backtest ===\n");
  const { candles, source } = await loadCandles();
  console.log(`  Data source: ${source}  (${candles.length} candles)\n`);

  const strategy = (candle: BTCandle, i: number): ArbDecision[] => {
    if (i === 0) return [{ index: i, found: false }];
    const lagged = candles[i - 1]!.close;
    const pools = buildTriangle(candle.close, lagged);

    const ranked: RankedCycle[] = findRankedCycles(pools, {
      baseMint: USDC,
      minIn: 10,
      maxIn: 100_000,
      // Fee gate: assume ~$5 total network/protocol fee per cycle, require 1.5x.
      estimatedFeeBase: 5,
      minProfitMultiplier: 1.5,
      minDepth: 3,
      maxDepth: 3,
    });

    if (ranked.length === 0) return [{ index: i, found: false }];
    const best = ranked[0]!;
    return [{
      index: i,
      found: true,
      label: cycleLabel(best.cycle),
      amountIn: best.amountIn,
      netProfit: best.netProfit,
    }];
  };

  const bt = new Backtest<BTCandle, ArbDecision>("arb-cycle-finder", strategy);
  bt.run(candles);

  const all = bt.allDecisions();
  const hits = all.filter((d) => d.found);
  const totalProfit = hits.reduce((a, d) => a + (d.netProfit ?? 0), 0);
  const maxProfit = hits.reduce((a, d) => Math.max(a, d.netProfit ?? 0), 0);
  const avgProfit = hits.length ? totalProfit / hits.length : 0;

  const result = bt.result({
    "data source": source,
    "candles": candles.length,
    "arbs detected": hits.length,
    "hit rate": `${((hits.length / candles.length) * 100).toFixed(1)}%`,
    "total sim net profit": `$${totalProfit.toFixed(2)}`,
    "avg profit / arb": `$${avgProfit.toFixed(2)}`,
    "max single arb": `$${maxProfit.toFixed(2)}`,
  });
  printResult(result);

  // Show a few sample detections.
  console.log("\n  Sample detections:");
  hits.slice(0, 5).forEach((d) =>
    console.log(`    candle ${d.index}: ${d.label}  in=$${d.amountIn?.toFixed(0)}  net=$${d.netProfit?.toFixed(2)}`)
  );

  // ── Sanity assertions (this doubles as a regression test) ──
  let failed = 0;
  const assert = (c: boolean, m: string) => {
    console.log(`  ${c ? "✅" : "❌ FAIL:"} ${m}`); if (!c) failed++;
  };
  console.log("\n  Assertions:");
  assert(candles.length > 10, "loaded a usable candle series");
  assert(all.length === candles.length, "one decision per candle");
  assert(hits.every((d) => (d.netProfit ?? 0) > 0), "every detected arb has positive simulated net profit");
  assert(hits.every((d) => (d.amountIn ?? 0) > 0), "every detected arb has a positive sized amountIn");

  console.log(`\n=== Backtest ${failed === 0 ? "PASSED" : "FAILED"} (${failed} assertion failures) ===\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
