/**
 * test_fee_sweep_backtest.ts — fee-guard sensitivity backtest.
 *
 * Replays the SAME real Binance series through the arb cycle finder at several
 * `minProfitMultiplier` values and shows the tradeoff: a stricter fee gate trades
 * less often but only on higher-quality (more profitable) gaps. This quantifies
 * the engine's fee-guard knob (settings: fees.max_fee_pct_of_profit /
 * UserConfig.minProfitMultiplier).
 *
 * Run: npx ts-node tests/backtests/test_fee_sweep_backtest.ts
 */

import { detectArb } from "./arb_scenario";
import { fetchBinanceCandles, syntheticCandles, type BTCandle } from "./binance_data";

const MULTIPLIERS = [1.0, 1.5, 2.0, 3.0];
const FEE_BASE = 5; // assumed $5 network/protocol fee per cycle

async function loadCandles(): Promise<{ candles: BTCandle[]; source: string }> {
  try {
    const candles = await fetchBinanceCandles("SOLUSDT", "1h", 500);
    if (candles.length > 10) return { candles, source: "Binance SOLUSDT 1h (real)" };
  } catch (e: any) {
    console.log(`  [!] Binance fetch failed (${e.message}); using synthetic fallback.`);
  }
  return { candles: syntheticCandles(500), source: "synthetic fallback" };
}

interface Row {
  mult: number;
  trades: number;
  totalProfit: number;
  avgProfit: number;
  minProfit: number;
}

async function main() {
  console.log("\n=== Fee-Guard Sensitivity Backtest ===\n");
  const { candles, source } = await loadCandles();
  console.log(`  Data: ${source} (${candles.length} candles), assumed fee $${FEE_BASE}/cycle\n`);

  const rows: Row[] = MULTIPLIERS.map((mult) => {
    const hits = [];
    for (let i = 1; i < candles.length; i++) {
      const hit = detectArb(candles[i]!.close, candles[i - 1]!.close, i, {
        estimatedFeeBase: FEE_BASE,
        minProfitMultiplier: mult,
      });
      if (hit.found) hits.push(hit);
    }
    const profits = hits.map((h) => h.netProfit ?? 0);
    const total = profits.reduce((a, b) => a + b, 0);
    return {
      mult,
      trades: hits.length,
      totalProfit: total,
      avgProfit: hits.length ? total / hits.length : 0,
      minProfit: hits.length ? Math.min(...profits) : 0,
    };
  });

  // Table
  console.log("  minProfitMult │ trades │ total $   │ avg $/trade │ worst $/trade");
  console.log("  ──────────────┼────────┼───────────┼─────────────┼──────────────");
  for (const r of rows) {
    console.log(
      `  ${r.mult.toFixed(1).padStart(13)} │ ${String(r.trades).padStart(6)} │ ` +
      `${("$" + r.totalProfit.toFixed(2)).padStart(9)} │ ${("$" + r.avgProfit.toFixed(2)).padStart(11)} │ ` +
      `${("$" + r.minProfit.toFixed(2)).padStart(12)}`
    );
  }

  console.log("\n  Interpretation:");
  console.log("  - Higher multiplier → fewer trades but each clears a larger margin.");
  console.log("  - The 'worst $/trade' column should be non-decreasing as the gate tightens.");

  // ── Assertions (the gate should behave monotonically) ──
  let failed = 0;
  const assert = (c: boolean, m: string) => { console.log(`  ${c ? "✅" : "❌ FAIL:"} ${m}`); if (!c) failed++; };
  console.log("\n  Assertions:");
  for (let i = 1; i < rows.length; i++) {
    assert(rows[i]!.trades <= rows[i - 1]!.trades,
      `stricter gate (x${rows[i]!.mult}) trades <= looser gate (x${rows[i - 1]!.mult})`);
  }
  for (let i = 1; i < rows.length; i++) {
    // worst-case trade quality should not get worse as the gate tightens
    assert(rows[i]!.trades === 0 || rows[i]!.minProfit >= rows[i - 1]!.minProfit - 1e-6,
      `worst trade at x${rows[i]!.mult} is no worse than at x${rows[i - 1]!.mult}`);
  }

  console.log(`\n=== Backtest ${failed === 0 ? "PASSED" : "FAILED"} (${failed} failures) ===\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
