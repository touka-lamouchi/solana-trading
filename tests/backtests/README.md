# Backtests

Replay historical/market data through the bot's **pure strategy code** (no chain,
no Redis, no execution) and measure what it *would* have done. Honest by design:
all profit numbers come from `simulateCycle`'s exact constant-product walk — never
fabricated.

## Files

| File | Purpose |
|---|---|
| `harness.ts` | Tiny reusable framework: feed a snapshot series → collect decisions → summarize. |
| `binance_data.ts` | Fetches real `SOLUSDT` klines from Binance (public API, no key). Falls back to a deterministic synthetic series when offline. |
| `arb_scenario.ts` | Shared triangle-pool builder + single-candle arb detector, reused by the arb backtests. |
| `test_arb_backtest.ts` | Backtests the **arbitrage cycle finder** on real Binance prices. |
| `test_fee_sweep_backtest.ts` | Sweeps the **fee-guard** `minProfitMultiplier` (1.0/1.5/2.0/3.0) → tradeoff curve (fewer trades vs higher quality). |
| `test_walkforward_backtest.ts` | **Walk-forward / out-of-sample**: tunes the fee gate on a train window, evaluates on an unseen test window (anti-overfit). |
| `test_signal_agreement_backtest.ts` | Backtests the **ASI01 signal-agreement gate**: under simulated sensor manipulation, shows the gate skips losing trades and lifts win rate. |

## Run

```bash
npx ts-node tests/backtests/test_arb_backtest.ts              # arb finder, real data
npx ts-node tests/backtests/test_fee_sweep_backtest.ts        # fee-guard sensitivity
npx ts-node tests/backtests/test_walkforward_backtest.ts      # out-of-sample rigor
npx ts-node tests/backtests/test_signal_agreement_backtest.ts # ASI01 security value
```

Each exits non-zero on assertion failure, so they double as regression tests.

The signal-agreement backtest runs fully **without** the AI server (deterministic
synthetic sensors). If `localhost:8000` is up it also probes the live sentiment
path, but that does not affect the result.

## How the arb backtest works

Each candle builds a 3-pool triangle (USDC/SOL, SOL/RAY, RAY/USDC) where the
USDC/SOL pool is priced at the **real** Binance close and the RAY/USDC pool lags
one candle. When SOL moves, the round-trip USDC→SOL→RAY→USDC is briefly
inconsistent → a real triangular arb. The backtest runs the same
`findRankedCycles → optimal_sizer → simulateCycle` path the live `ArbReactor`
uses, applying the same fee gate (`minProfitMultiplier`).

A low hit rate is expected and correct: when the market is calm there is no arb,
and the bot reports none — same as production.

## Extending

To make arbs more/less frequent, widen the lag or add a static spread in
`buildTriangle`. To backtest a different pair, change the symbol in `loadCandles`.
For an AI-strategy backtest, add a new `test_*_backtest.ts` that drives candles
through `DecisionModel` (requires the Python AI server running).
