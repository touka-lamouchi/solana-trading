/**
 * test_signal_agreement_backtest.ts — backtests the ASI01 signal-agreement gate.
 *
 * Question: does the new ASI01 reliability flag (computeSignalAgreement +
 * AGREEMENT_FLOOR, wired into check_ai_threshold) actually add trading value, or
 * just block trades arbitrarily?
 *
 * Method (deterministic, no live AI server needed for the core result):
 *   1. Replay real Binance candles. The "true" next-candle direction is the
 *      ground truth (did price go up or down?).
 *   2. For each candle, synthesize 5 sensor scores that mostly agree with the
 *      true direction — EXCEPT on a subset of candles we "poison" one sensor to
 *      point the opposite way (simulating a manipulated mempool / injected
 *      sentiment — the exact ASI01 threat).
 *   3. Aggregate to an aiScore and a direction, exactly like DecisionModel.
 *   4. Compare two policies:
 *        BASELINE — trade whenever aiScore crosses threshold (no ASI01 gate).
 *        GATED    — additionally skip trades flagged unreliable (agreement < floor).
 *   5. Score each taken trade as win/loss vs the true next-candle direction.
 *
 * If ASI01 works, the GATED policy should have a HIGHER win rate than BASELINE,
 * because it skips exactly the poisoned/contradictory signals that mislead.
 *
 * Optional: if the Python AI server is running on :8000, we additionally pull one
 * real sentiment score to confirm the live path is reachable (not required to pass).
 *
 * Run: (optional) cd ai && python server.py   # :8000
 *      npx ts-node tests/backtests/test_signal_agreement_backtest.ts
 */

import { computeSignalAgreement, AGREEMENT_FLOOR } from "../../src/layer1_opportunity/decision_model";
import { fetchBinanceCandles, syntheticCandles, BACKTEST_END_TIME, type BTCandle } from "./binance_data";

const POISON_EVERY = 7;       // poison one sensor on every Nth candle
const TRADE_THRESHOLD = 0.6;  // |aiScore-0.5| band that triggers a directional trade

async function loadCandles(): Promise<{ candles: BTCandle[]; source: string }> {
  try {
    const candles = await fetchBinanceCandles("SOLUSDT", "1h", 500, BACKTEST_END_TIME);
    if (candles.length > 10) return { candles, source: "Binance SOLUSDT 1h (real, fixed window)" };
  } catch (e: any) {
    console.log(`  [!] Binance fetch failed (${e.message}); using synthetic fallback.`);
  }
  return { candles: syntheticCandles(500), source: "synthetic fallback" };
}

// Deterministic pseudo-random in [0,1) from an integer seed (no external dep).
function rng(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

interface Outcome { taken: number; wins: number; }

async function main() {
  console.log("\n=== ASI01 Signal-Agreement Gate Backtest ===\n");
  const { candles, source } = await loadCandles();
  console.log(`  Data: ${source} (${candles.length} candles)`);
  console.log(`  Poisoning 2 sensors every ${POISON_EVERY} candles (simulated coordinated manipulation)\n`);

  // Optional liveness probe of the real AI server (does not affect pass/fail).
  try {
    const res = await fetch("http://localhost:8000/health", { signal: AbortSignal.timeout(3000) });
    console.log(`  AI server: ${res.ok ? "reachable (live sentiment path OK)" : "responded " + res.status}\n`);
  } catch {
    console.log("  AI server: not running — using deterministic synthetic sensors only\n");
  }

  const baseline: Outcome = { taken: 0, wins: 0 };
  const gated: Outcome = { taken: 0, wins: 0 };
  let flaggedUnreliable = 0;
  let flaggedThatWouldLose = 0;

  for (let i = 1; i < candles.length - 1; i++) {
    // Ground truth: direction of the NEXT candle.
    const trueUp = candles[i + 1]!.close >= candles[i]!.close;

    // Build 5 sensors that agree with the truth, moderately (not extreme), so a
    // strong enough manipulation can actually flip the aggregate verdict.
    const agreeScore = trueUp ? 0.62 : 0.38;
    const scores = [0, 1, 2, 3, 4].map((s) => {
      const noise = (rng(i * 10 + s) - 0.5) * 0.1;
      return Math.max(0, Math.min(1, agreeScore + noise));
    });

    // Poison: on selected candles, flip TWO sensors to the opposite extreme —
    // enough to drag the aggregate the wrong way and produce a losing trade.
    // This is the ASI01 threat: coordinated manipulation of a minority of sensors.
    const poisoned = i % POISON_EVERY === 0;
    if (poisoned) {
      scores[i % 5] = trueUp ? 0.02 : 0.98;
      scores[(i + 2) % 5] = trueUp ? 0.02 : 0.98;
    }

    const aiScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    const { agreement } = computeSignalAgreement(scores);
    const reliable = agreement >= AGREEMENT_FLOOR;

    // Trade trigger: aiScore far enough from neutral.
    const wantsTrade = aiScore >= TRADE_THRESHOLD || aiScore <= 1 - TRADE_THRESHOLD;
    if (!wantsTrade) continue;

    const predictedUp = aiScore >= 0.5;
    const win = predictedUp === trueUp;

    // BASELINE: always trade.
    baseline.taken++;
    if (win) baseline.wins++;

    // GATED: skip when unreliable.
    if (reliable) {
      gated.taken++;
      if (win) gated.wins++;
    } else {
      flaggedUnreliable++;
      if (!win) flaggedThatWouldLose++;
    }
  }

  const wr = (o: Outcome) => (o.taken ? (o.wins / o.taken) * 100 : 0);
  console.log("  policy   │ trades │ wins │ win rate");
  console.log("  ─────────┼────────┼──────┼─────────");
  console.log(`  baseline │ ${String(baseline.taken).padStart(6)} │ ${String(baseline.wins).padStart(4)} │ ${wr(baseline).toFixed(1)}%`);
  console.log(`  ASI01    │ ${String(gated.taken).padStart(6)} │ ${String(gated.wins).padStart(4)} │ ${wr(gated).toFixed(1)}%`);

  console.log("\n  ASI01 gate impact:");
  console.log(`  - Trades flagged unreliable & skipped: ${flaggedUnreliable}`);
  console.log(`  - Of those, how many would have LOST:  ${flaggedThatWouldLose} ` +
              `(${flaggedUnreliable ? ((flaggedThatWouldLose / flaggedUnreliable) * 100).toFixed(0) : 0}%)`);
  console.log(`  - Win-rate improvement: ${(wr(gated) - wr(baseline)).toFixed(1)} pts`);

  // ── Assertions ──
  let failed = 0;
  const assert = (c: boolean, m: string) => { console.log(`  ${c ? "✅" : "❌ FAIL:"} ${m}`); if (!c) failed++; };
  console.log("\n  Assertions:");
  assert(baseline.taken > 0, "baseline took some trades");
  assert(flaggedUnreliable > 0, "ASI01 flagged at least some poisoned signals as unreliable");
  assert(wr(gated) >= wr(baseline) - 1e-6, "ASI01-gated win rate >= baseline (gate does not hurt)");
  assert(flaggedThatWouldLose > 0, "ASI01 skipped at least one trade that would have lost");

  console.log(`\n=== Backtest ${failed === 0 ? "PASSED" : "FAILED"} (${failed} failures) ===\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
