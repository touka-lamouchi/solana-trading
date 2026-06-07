/**
 * test_walkforward_backtest.ts — walk-forward (out-of-sample) backtest.
 *
 * Demonstrates proper backtesting methodology: parameters are TUNED on a "train"
 * window and then evaluated on a *separate, later* "test" window the tuner never
 * saw. This guards against overfitting — a strategy that only looks good because
 * its parameters were cherry-picked on the same data it's measured on.
 *
 * Here the tunable parameter is the fee-guard `minProfitMultiplier`. For each
 * rolling fold we:
 *   1. Sweep multipliers on the train window, pick the one with the best
 *      risk-adjusted score (total profit, penalizing near-fee marginal trades).
 *   2. Apply that single chosen multiplier to the unseen test window.
 *   3. Compare test-window outcomes to the naive baseline (loosest gate, x1.0).
 *
 * Run: npx ts-node tests/backtests/test_walkforward_backtest.ts
 */

import { detectArb } from "./arb_scenario";
import { fetchBinanceCandles, syntheticCandles, BACKTEST_END_TIME, type BTCandle } from "./binance_data";

const CANDIDATE_MULTS = [1.0, 1.25, 1.5, 2.0, 2.5, 3.0];
const FEE_BASE = 5;
const TRAIN = 150; // candles to tune on
const TEST = 75;   // candles to evaluate on (out-of-sample)

async function loadCandles(): Promise<{ candles: BTCandle[]; source: string }> {
  try {
    const candles = await fetchBinanceCandles("SOLUSDT", "1h", 1000, BACKTEST_END_TIME);
    if (candles.length > TRAIN + TEST + 1) return { candles, source: "Binance SOLUSDT 1h (real, fixed window)" };
  } catch (e: any) {
    console.log(`  [!] Binance fetch failed (${e.message}); using synthetic fallback.`);
  }
  return { candles: syntheticCandles(1000), source: "synthetic fallback" };
}

interface WindowResult { trades: number; total: number; worst: number; }

// Run the arb detector over [from, to) at a fixed multiplier.
function evalWindow(candles: BTCandle[], from: number, to: number, mult: number): WindowResult {
  const profits: number[] = [];
  for (let i = Math.max(1, from); i < to; i++) {
    const hit = detectArb(candles[i]!.close, candles[i - 1]!.close, i, {
      estimatedFeeBase: FEE_BASE, minProfitMultiplier: mult,
    });
    if (hit.found) profits.push(hit.netProfit ?? 0);
  }
  return {
    trades: profits.length,
    total: profits.reduce((a, b) => a + b, 0),
    worst: profits.length ? Math.min(...profits) : 0,
  };
}

// Risk-adjusted training score: reward total profit, penalize taking trades whose
// worst case barely clears the fee (those are the fragile ones).
function trainScore(r: WindowResult): number {
  if (r.trades === 0) return -Infinity;
  return r.total + r.worst * 2; // weight worst-case quality
}

async function main() {
  console.log("\n=== Walk-Forward (Out-of-Sample) Backtest ===\n");
  const { candles, source } = await loadCandles();
  console.log(`  Data: ${source} (${candles.length} candles)`);
  console.log(`  Folds: train=${TRAIN} candles → test=${TEST} candles (rolling)\n`);

  const folds: { fold: number; chosenMult: number; chosen: WindowResult; baseline: WindowResult }[] = [];
  let foldNum = 0;
  for (let start = 0; start + TRAIN + TEST <= candles.length; start += TEST) {
    foldNum++;
    const trainFrom = start, trainTo = start + TRAIN;
    const testFrom = trainTo, testTo = trainTo + TEST;

    // 1. Tune on train.
    let best = { mult: CANDIDATE_MULTS[0]!, score: -Infinity };
    for (const m of CANDIDATE_MULTS) {
      const s = trainScore(evalWindow(candles, trainFrom, trainTo, m));
      if (s > best.score) best = { mult: m, score: s };
    }
    // 2. Apply chosen mult out-of-sample.
    const chosen = evalWindow(candles, testFrom, testTo, best.mult);
    // 3. Baseline = loosest gate on the same test window.
    const baseline = evalWindow(candles, testFrom, testTo, 1.0);
    folds.push({ fold: foldNum, chosenMult: best.mult, chosen, baseline });
  }

  if (folds.length === 0) {
    console.log("  Not enough data for a fold. Need more candles.");
    process.exit(1);
  }

  console.log("  fold │ chosen mult │ OOS trades │ OOS total │ OOS worst │ baseline(x1) total/worst");
  console.log("  ─────┼─────────────┼────────────┼───────────┼───────────┼─────────────────────────");
  for (const f of folds) {
    console.log(
      `  ${String(f.fold).padStart(4)} │ ${f.chosenMult.toFixed(2).padStart(11)} │ ` +
      `${String(f.chosen.trades).padStart(10)} │ ${("$" + f.chosen.total.toFixed(2)).padStart(9)} │ ` +
      `${("$" + f.chosen.worst.toFixed(2)).padStart(9)} │ ` +
      `$${f.baseline.total.toFixed(2)} / $${f.baseline.worst.toFixed(2)}`
    );
  }

  const oosWorst = folds.map((f) => f.chosen.worst).filter((_, i) => folds[i]!.chosen.trades > 0);
  const baseWorst = folds.map((f) => f.baseline.worst).filter((_, i) => folds[i]!.baseline.trades > 0);
  const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

  console.log("\n  Summary:");
  console.log(`  - Folds evaluated: ${folds.length}`);
  console.log(`  - Avg OOS worst-trade (tuned gate):  $${avg(oosWorst).toFixed(2)}`);
  console.log(`  - Avg OOS worst-trade (baseline x1): $${avg(baseWorst).toFixed(2)}`);
  console.log("  - A tuned gate that generalizes should show better (higher) worst-case");
  console.log("    trade quality out-of-sample than the naive loose baseline.");

  // ── Assertions ──
  let failed = 0;
  const assert = (c: boolean, m: string) => { console.log(`  ${c ? "✅" : "❌ FAIL:"} ${m}`); if (!c) failed++; };
  console.log("\n  Assertions:");
  assert(folds.length >= 1, "produced at least one walk-forward fold");
  assert(folds.every((f) => CANDIDATE_MULTS.includes(f.chosenMult)), "each fold chose a valid multiplier");
  assert(avg(oosWorst) >= avg(baseWorst) - 1e-6,
    "tuned gate's OOS worst-case trade quality >= naive baseline (no overfit penalty)");

  console.log(`\n=== Backtest ${failed === 0 ? "PASSED" : "FAILED"} (${failed} failures) ===\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
