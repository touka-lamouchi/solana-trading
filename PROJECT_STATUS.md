# Solana Trading Bot — Project Status

> DevNet-first, Mainnet-last. TypeScript + Python AI server + Anchor smart contracts.
> Last updated: 2026-04-02

---

## What This Bot Does

Fully autonomous trading bot on Solana that:
1. **Watches** pools and markets for profitable opportunities
2. **Classifies** each opportunity as fast path (flash loan, zero capital risk) or slow path (own capital, needs AI confirmation)
3. **Validates** every trade through a multi-layer safety pipeline before touching money
4. **Executes** trades on-chain using Anchor programs, protected against MEV/sandwich attacks
5. **Protects** the bot's capital with auto-pause, daily drawdown limits, and hard slippage guards

---

## Architecture Overview

```
Market Data (on-chain pools, off-chain feeds)
        │
        ▼
┌─────────────────────────────────────────┐
│  LAYER 1: Opportunity Detection          │
│  - ArbitrageDetector (direct + triangular)│
│  - LiquidationHunter                    │
│  - YieldRateMonitor                     │
│  - SafetyPipeline (s1→s4 filters)       │
│  - OpportunityRouter → "fast" or "slow" │
└─────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────┐
│  LAYER 2: Execution Planning             │
│  - RoutePlanner (single-hop / multi-hop)│
│  - FeeCalculator (priority fees, profit %)│
│  - TransactionBuilder (AMM + flash loan)│
│  - SandwichDetector (MEV pre-check)     │
└─────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────┐
│  LAYER 3: Protection Wrappers            │
│  - TxSubmitter (canExecuteTrade gate)   │
│  - HardSlippageLimits (on-chain sim)    │
│  - JitoMevProtection (bundle submission)│
│  - AutoPause (failure counter)          │
│  - DailyDrawdown (capital limiter)      │
└─────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────┐
│  ON-CHAIN: Anchor Programs (DevNet)     │
│  - programs-amm: swap, add/remove liq  │
│  - programs-protection: flash loan,     │
│    slippage guard, drawdown vault,      │
│    auto-pause, update_vault             │
└─────────────────────────────────────────┘
```

---

## Fast Path vs Slow Path

Every opportunity is immediately classified by `OpportunityRouter` before any execution:

| Opportunity | Path | Why |
|---|---|---|
| Arbitrage (direct/triangular) | **fast** | Flash loan — borrow → swap → repay atomically, zero own capital at risk |
| Liquidation | **fast** | Flash loan — same atomic pattern |
| Yield farming | **slow** | Uses own capital — requires AI model confirmation before executing |
| Unknown type | **slow** | Safety default |

**Fast path:** executes immediately after safety checks pass. No AI needed.

**Slow path:** must wait for `decision_model.ts` to confirm that LSTM + sentiment + whale signals all agree the trade is safe. **This gate is not yet implemented** — it requires Phase 8 AI models.

---

## What Is Done

### Phase 1 — Infrastructure
- `src/infrastructure/solana_rpc.ts` — Solana connection + slot subscription
- `src/utils/wallet.ts` — wallet loader from JSON keypair
- `src/utils/logger.ts` — structured JSON logger (pino)
- `src/utils/metrics.ts` — Prometheus metrics
- `src/utils/config.ts` — singleton YAML config loader (`getConfig()`, `getStrategyConfig()`)
- `config/settings.yaml`, `config/strategy_params.yaml` — all bot parameters, no hardcodes in source
- Redis connection via `CacheManager`
- gRPC bridge skeleton

### Phase 2 — DevNet Simulation
- `scripts/devnet/create_tokens.ts` — mints 3 fake SPL tokens (fUSDC, fSOL, fRAY)
- `scripts/devnet/create_pools.ts` — creates 3 AMM pools (pool1: fUSDC/fSOL, pool2: fSOL/fRAY, pool3: fUSDC/fRAY)
- `scripts/devnet/create_dirty_tokens.ts` — tokens that fail safety filters (for testing s1–s4)
- `scripts/devnet/simulator_cli.ts` — CLI to manually trigger swaps on devnet

### Phase 3 — Redis Cache Layer
- `src/cache/sentiment_cache.ts` — stores sentiment scores per token
- `src/cache/whale_cache.ts` — stores whale wallet activity
- `src/cache/lstm_cache.ts` — stores LSTM model predictions
- `src/cache/token_score_cache.ts` — stores combined token trust scores
- `src/cache/ema_tracker.ts` — exponential moving average per token
- `src/cache/cache_manager.ts` — unified cache interface, Redis ping/health

### Phase 4 — Opportunity Detectors
- `src/layer1_opportunity/pure_code/arbitrage_detector.ts` — reads live pool reserves, calculates direct and triangular arb profit using AMM constant-product formula
- `src/layer1_opportunity/pure_code/liquidation_hunter.ts` — watches undercollateralized positions
- `src/layer1_opportunity/pure_code/yield_rate_monitor.ts` — monitors yield rate differentials
- `src/layer1_opportunity/opportunity_router.ts` — classifies every opportunity as fast or slow, logs reason

### Phase 5 — Safety Filters
Four filters run in sequence on every opportunity before it reaches execution:
- `s1_onchain_heuristics.ts` — checks token age, liquidity, ownership concentration
- `s2_honeypot_detector.ts` — simulates a sell to check if the token is a trap
- `s3_isolation_forest.ts` — anomaly detection on trade patterns
- `s4_anomaly_detection.ts` — secondary statistical anomaly check
- `safety_pipeline.ts` — runs s1→s2→s3→s4 in order, stops on first failure

### Phase 6 — Anchor Programs (deployed on DevNet)
Two on-chain programs:

**programs-amm:**
- `swap` — constant-product AMM swap (fee: 997/1000 from config)
- `add_liquidity` / `remove_liquidity` — LP position management

**programs-protection:**
- `initialize_flash_vault` — creates the PDA vault that holds flash loan capital
- `flash_borrow` — borrow from vault; enforces `flash_repay` exists in same tx via instruction introspection
- `flash_repay` — repay flash loan to vault, enforces repay ≥ borrow, increments loan counter
- `update_vault` — updates the stored vault token account in the PDA (added when original keypair was lost)

> Note: slippage guard, drawdown, and auto-pause were considered for on-chain implementation but are handled off-chain in `src/protection/` and `src/layer3_protection/` instead. Only the flash loan vault lives on-chain.

### Phase 7 — Layer 2 Execution
- `src/layer2_execution/route_planner.ts` — plans single-hop and multi-hop swap routes
- `src/layer2_execution/fee_calculator.ts` — calculates priority fees, checks fee is within % of expected profit
- `src/layer2_execution/transaction_builder.ts` — builds swap transactions and flash loan bundles, signs, sends
- `src/layer3_protection/tx_submitter.ts` — runs `canExecuteTrade()` pre-check, then submits, records result
- `src/layer2_execution/sandwich_detector.ts` — checks live pool for same-slot transactions before submitting

**Test:** `scripts/devnet/test_full_trade.ts` — passes. Executes a real devnet swap, detects arb, runs flash loan arb.

### Phase 8 (partial) — AI Server
- `ai/server.py` — FastAPI server with only `/health` endpoint. No models yet.

### Phase 9 — Layer 3 Protections
**Core logic** (`src/protection/`):
- `auto_pause.ts` — counts consecutive failures, pauses bot after threshold
- `drawdown.ts` — tracks capital spent today, blocks trades over daily limit, auto-pauses at 90%
- `slippage_guard.ts` — calculates minimum acceptable output for a given slippage tolerance
- `trading_hours.ts` — enforces allowed trading time window (or 24/7 mode)
- `protection_manager.ts` — orchestrates all four checks in one `canExecuteTrade()` call

**Solana wrappers** (`src/layer3_protection/`):
- `auto_pause.ts` — wraps core AutoPause, also cancels any queued slow-path transactions when pause fires
- `daily_drawdown.ts` — wraps core Drawdown, emits `dailyLimitHit` EventEmitter event when limit is hit
- `hard_slippage_limits.ts` — simulates the real transaction on-chain before submitting, rejects if simulated output fails slippage check
- `jito_mev_protection.ts` — bundles transactions via Jito block engine REST API with tip transaction appended; dry-run mode on devnet
- `tx_submitter.ts` — the final gate before any transaction hits the network

**Tests:**
- `scripts/devnet/test_phase9.ts` — in-memory unit tests for all protection logic
- `scripts/devnet/test_protection_integration.ts` — real devnet transactions: auto-pause fires after 3 real failures, drawdown blocks after real capital spent, slippage pre-flight rejects at 0 bps, Jito dry-run validates bundle path

---

## What Is Missing

### Phase 8 — AI Models (BLOCKED — nothing started)

The Python server exists but has no models. Need to implement:

| File | What it does |
|---|---|
| `ai/server.py` | Add endpoints: `POST /predict/price` (LSTM), `POST /predict/sentiment`, `POST /predict/whale`, `POST /predict/slippage`, `POST /predict/volatility` |
| `src/layer1_opportunity/ai_signals/lstm_signal.ts` | Calls `/predict/price`, returns confidence score for price direction |
| `src/layer1_opportunity/ai_signals/sentiment_signal.ts` | Calls `/predict/sentiment`, reads from `sentiment_cache.ts` |
| `src/layer1_opportunity/ai_signals/whale_signal.ts` | Calls `/predict/whale`, reads from `whale_cache.ts` |
| `src/layer1_opportunity/decision_model.ts` | Aggregates lstm + sentiment + whale scores, returns go/no-go for slow path |
| `src/layer2_execution/slippage_optimizer.ts` | Calls `/predict/slippage`, picks optimal slippage bps per token pair |
| `src/layer2_execution/volatility_predictor.ts` | Calls `/predict/volatility`, feeds into route planner |

### Phase 9 (remaining) — Slow Path Gate

The `TxSubmitter` accepts `pathType: "fast" | "slow"` but both paths execute immediately. The slow path gate needs:

| File | What to add |
|---|---|
| `src/layer3_protection/tx_submitter.ts` | When `pathType === "slow"`, call `decision_model.canExecute()` before submitting. If AI says no, queue or drop the trade. |
| `src/layer1_opportunity/decision_model.ts` | Must be implemented first (Phase 8 dependency) |

### Phase 11 — Trading Engine (DONE)

`src/engine/trading_engine.ts` — the bot brain. `TradingEngine` class with `tick()` method:
- Phase A (Discover): scan ALL pools, collect ALL opportunities
- Phase B (Execute): for each opportunity: safety → route → guard → execute
- Guards fire INSIDE the opportunity loop, not as separate sections

`src/main.ts` — boots infrastructure, creates engine, calls `engine.startLoop(10_000)`
- Graceful shutdown on SIGINT/SIGTERM

`scripts/devnet/test_e2e_pipeline.ts` — boots engine, calls `tick()` once, asserts 7 checks

### Phase 12 — Mainnet Preparation (not started)
- Redeploy Anchor programs on mainnet
- Real token mint addresses in config
- Real RPC endpoint (Helius / Triton)
- Jito mainnet block engine URL

### Phase 13 — Frontend Dashboard (not started)
- Real-time trade log
- P&L chart
- Protection status (pause state, drawdown %)
- Start/stop control UI

### Phase 14 — Production Deployment (not started)
- Docker container
- Process manager (PM2 or systemd)
- Alerting (Telegram / Discord on pause/limit events)

---

## Dependency Chain

```
Phase 8 (AI models)
    │
    ├──► Phase 9 slow-path gate (decision_model.ts)
    │
    └──► Phase 11 (main.ts loop — needs decision_model for slow path)
              │
              └──► Phase 12 → 13 → 14
```

**You can start Phase 11 partially** (wire the fast path loop in main.ts) without Phase 8, since fast-path trades don't need AI confirmation. Slow-path trades just won't execute until Phase 8 is done.

---

## DevNet Test Commands

```bash
# Full trade test (swap + arb + flash loan)
npx ts-node scripts/devnet/test_full_trade.ts

# Phase 9 unit tests (in-memory)
npx ts-node scripts/devnet/test_phase9.ts

# Phase 9 integration tests (real devnet txs)
npx ts-node scripts/devnet/test_protection_integration.ts

# On-chain protection program tests
npx ts-node scripts/devnet/test_protection.ts

# Simple transaction test
npx ts-node scripts/devnet/test_transaction.ts
```

---

## Key Config Files

| File | Purpose |
|---|---|
| `config/settings.yaml` | All bot settings: RPC, fees, AMM params, protection thresholds, Jito config |
| `config/strategy_params.yaml` | Strategy-specific params: min profit %, enabled strategies |
| `config/devnet_tokens.json` | Deployed token mint addresses on devnet |
| `config/devnet_pools.json` | Deployed pool addresses on devnet |
| `config/dev-wallet.json` | DevNet wallet keypair (gitignored) |
