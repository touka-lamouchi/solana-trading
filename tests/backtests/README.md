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
| `test_arb_backtest.ts` | Backtests the **arbitrage cycle finder** on real Binance prices. |

## Run

```bash
# Arbitrage cycle finder on real Binance data
npx ts-node tests/backtests/test_arb_backtest.ts
```

Exits non-zero on assertion failure, so it doubles as a regression test.

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
