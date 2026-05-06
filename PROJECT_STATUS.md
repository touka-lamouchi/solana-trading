# Solana Trading Bot — Project Status

> Multi-user agentic trading platform on Solana. AI signals on real mainnet data, trade execution on devnet pools.
> TypeScript engine + Python AI server + 3 deployed Anchor programs + React frontend.

---

## What This Bot Does

1. **Watches** real Solana mainnet activity (whales, mempool flow, Reddit sentiment, candle regime, GRU vol-expansion) for predictive signals on tracked tokens (default: wSOL).
2. **Detects** opportunities through 7 detectors — 3 deterministic (arb, yield, liquidation) + 4 AI-driven (chart_pattern, social_buzz, copy_whale, mempool_pressure).
3. **Decides** with one weighted aggregator (`DecisionModel`) that runs the 5 ML signals in parallel and returns one `aiScore` + direction.
4. **Validates** every trade through a multi-layer safety pipeline (S1→S4) and a fee-aware profit guard.
5. **Executes** on the user's devnet AMM pools, with the per-user **vault PDA** as the SPL transfer authority. Tokens never touch the bot wallet on slow-path trades, and optionally not even on flash-loan arbs (`useVaultFlashArb`).
6. **Protects** capital with auto-pause, daily drawdown, slippage guards, and a min-profit-vs-network-fee gate.

---

## Architecture Overview

```
              Real-world data (mainnet)
              ────────────────────────
               │  candles (Binance)
               │  Reddit + Gemini/VADER
               │  whale wallets (mainnet RPC)
               │  Raydium V4 + Orca Whirlpool log streams
               ▼
   ┌────────────────────────────────────────┐
   │   AI BRAIN (5 sensors → 1 aggregator)  │
   │   regime · sentiment · whale ·          │
   │   vol-expansion · mempool                │
   │      ↓ Promise.all                      │
   │   DecisionModel.computeScore             │
   │      → aiScore, direction               │
   └────────────────────────────────────────┘
               │
               ▼
   ┌────────────────────────────────────────────────────┐
   │   EVENT SOURCES                                    │
   │   ArbReactor ──────────────► arb_opportunity       │
   │   LiquidationReactor ──────► liq_opportunity       │
   │   CandleReactor (shared) ──► candle_closed         │
   │   SignalsTimer (per lane) ──► signals_timer         │
   └────────────────────────────────────────────────────┘
               │
               ▼ (per-user EventQueue, bounded 256, per-kind drop policy)
   ┌────────────────────────────────────────────────────┐
   │   UserLane consumer loop                           │
   │   → picks entry point by event kind               │
   │   → invokes LangGraph                             │
   └────────────────────────────────────────────────────┘
               │
               ▼
   ┌────────────────────────────────────────────────────┐
   │   LANGGRAPH (src/graph/)                           │
   │                                                    │
   │   signals_timer: full discovery subgraph           │
   │     scan_pools → [detect_arbs, detect_yields,      │
   │                   detect_liquidations,             │
   │                   ingest_candles → ai_decision     │
   │                   → detect_chart_pattern,          │
   │                      detect_social_buzz,           │
   │                      detect_whale_copy,            │
   │                      detect_mempool_pressure,      │
   │                      build_directional]            │
   │     → filter_by_config                             │
   │                                                    │
   │   arb/liq: fast path only                          │
   │     pre-filled → pick_next → route → fast path     │
   │                                                    │
   │   candle: AI refresh + detector subgraph           │
   │                                                    │
   │   Execution loop (FIFO per opportunity):           │
   │   pick_next → route                                │
   │   fast: log_whale → check_guard → check_vault      │
   │          → execute_fast → pick_next                │
   │   slow: check_ai_threshold → check_safety         │
   │         → log_whale → check_guard                  │
   │         → execute_slow → pick_next                 │
   │   → build_summary → emit_status → END              │
   └────────────────────────────────────────────────────┘
               │
               ▼
   ┌────────────────────────────────────────┐
   │   LAYER 2: TransactionBuilder           │
   │   - flash arb + sweep profit to vault   │
   │   - vault.bot_swap (slow path)          │
   │   - vault.bot_arb (vault capital)       │
   │   - vault.bot_arb_via_flash (nested CPI)│
   └────────────────────────────────────────┘
               │
               ▼
   ┌────────────────────────────────────────┐
   │   ON-CHAIN (DevNet, 3 programs)        │
   │   - AMM (4 pools)                       │
   │   - Flash loan vault                    │
   │   - Per-user vault PDAs (one per Phantom)│
   └────────────────────────────────────────┘
```

---

## Trade Execution Paths

| Opportunity type | Default builder | Optional builder | Custody |
|---|---|---|---|
| Triangular arb | `buildFlashLoanArbTransaction` (bot wallet borrows, profit sweep into vault) | `buildVaultArbViaFlashTransaction` if `useVaultFlashArb=true` (vault PDA = sole borrower + custodian) | bot transit by default; vault-only with flag |
| Triangular arb (vault capital) | — | `buildVaultArbTransaction` if `useVaultArb=true` (uses vault balance, no flash) | vault PDA throughout |
| Slow path: yield, directional, chart_pattern, social_buzz, copy_whale, mempool_pressure | `buildVaultSwapTransaction` (vault PDA → AMM CPI) | — | vault PDA throughout |
| Liquidation | not yet executable | — | logged with reason; needs a real lending program |

**Fee guard:** every flash arb estimates network fees (priority × CU + base × $SOL) and skips if `expectedProfit < networkFee × minProfitMultiplier` (default 1.5×). No more sub-cent gaps eaten by fees.

**Per-trade cap precedence:** `min(userConfig.maxTradeUsd, settings.capital.flash_loan_max_usd, opp.amountIn)` — depositing more + raising your max in BotBuilder actually scales the borrow amount.

---

## What Is Done

### Phases 1–13 (original roadmap)

| Phase | Status | Notes |
|---|---|---|
| 1 Infrastructure | ✅ | RPC, wallet, logger, metrics, Redis, singleton YAML loaders |
| 2 DevNet simulation | ✅ | 3 SPL tokens, 3 clean pools + 1 dirty, mint authorities revoked |
| 3 Redis cache layer | ✅ | sentiment, whale, lstm, token_score, ema caches |
| 4 Opportunity detectors (7) | ✅ | All real data, zero synthetic seeds |
| 5 Safety filters | ✅ | S1→S4 pipeline |
| 6 Anchor programs (3) | ✅ | AMM + Flash loan + User vault, all deployed devnet |
| 7 Execution layer | ✅ | 5 transaction builders incl. vault-routed paths |
| 8 AI server | ✅ | 4 endpoints: regime, direction, sentiment, vol-expansion |
| 9 Protection | ✅ | auto-pause, drawdown, slippage, trading hours, vault gating, fee guard |
| 10 RWA | ❌ CANCELLED | |
| 11 Trading engine loop | ✅ | startLoop (single-user), startReactors (multi-user) |
| 12 Mainnet prep | ⚠️ PARTIAL | AI signals on mainnet; trading still on devnet |
| 13 Frontend | ✅ | LiveCockpit, BotBuilder, AnalyticsHub — all real-data wired |

### Graph refactor (LangGraph orchestration) — Phases 0–5 DONE

| Graph Phase | Status | What it added |
|---|---|---|
| 0 — Foundation | ✅ | events.ts, queue.ts, deps.ts + @langchain/langgraph dep |
| 1 — Graph definition | ✅ | state.ts, all discovery + execution nodes, build.ts, entries.ts |
| 2 — Per-user lane infrastructure | ✅ | user_lane.ts — queue + consumer loop + signals timer |
| 3 — Signal detectors through graph | ✅ | signals_timer → full discovery; deleted detector code from slowTick() |
| 4 — Reactors as pure event sources | ✅ | ArbReactor + LiquidationReactor enqueue to lane; CandleReactor fans out |
| 5 — Concurrency hardening | ✅ | Bounded queue (256), drop policy, backpressure metrics on /status, drain timeout, integration tests |
| **6 — Honest liquidation** | ✅ DONE | programs-lending Anchor program + LendingClient + execute_liq + accountSubscribe reactor |

#### Phase 5 details

Queue drop policy per kind:
- `drop_oldest`: pool_changed, mempool_pressure, signals_timer
- `drop_newest`: arb_opportunity, liq_opportunity
- `never_drop`: candle_closed

Backpressure metrics exposed on `/users/:userId/status` under `"queue"` key.

Tests added:
- `tests/integration/test_graph_arb.ts`
- `tests/integration/test_graph_liquidation.ts`
- `tests/integration/test_lane_backpressure.ts`
- `tests/unit/test_graph_topology.ts`
- `tests/unit/test_lane_inert.ts`

---

## What's Next

### Graph Phase 6 — Honest liquidation (DONE — D2)

All three sub-phases shipped:
- **6a**: `programs-lending/` Anchor program — `LoanPosition` PDA account, `register_position` + `liquidate` instructions with on-chain health check (cross-multiply to avoid integer overflow)
- **6b**: `src/layer2_execution/lending_client.ts` — IDL wrapper; `execute_liq.ts` graph node; `TradingEngine.executeLiquidationPublic()` private path; `route.ts` / `build.ts` updated for `"liq"` path; `LiquidationHunter` upgraded to `loadFromChain()`; `user_registry.ts` lazy-inits `LendingClient` and injects into `EngineDeps`
- **6c**: `LiquidationReactor` now uses `accountSubscribe` on each position PDA (immediate notification); falls back to Redis poll when `lendingClient` is absent

Deploy sequence:
```bash
cd programs-lending && anchor build && anchor deploy --provider.cluster devnet
npx ts-node scripts/devnet/setup/08_deploy_lending.ts
npx ts-node scripts/devnet/trigger/register_position.ts \
  --collateralToken=fSOL --collateralAmount=5 --debtToken=fUSDC --debtAmount=800 --threshold=1.20
```

### Other remaining items

| Item | What it needs |
|---|---|
| DefiLlama yield reader | Wire `https://yields.llama.fi/pools` into YieldRateMonitor |
| Helius enhanced WS | Faster mempool data (public RPC works now) |
| LLMAdvisor / AITuning pages | Currently stubs |
| Mainnet trading | Real USDC vault, Jupiter aggregator, real Pyth prices |
| Production deployment (Phase 14) | NOT STARTED |

---

## DevNet Setup & Test Commands

```bash
# One-time per Redis restart
redis-server --daemonize yes
npx ts-node scripts/devnet/populate_caches.ts

# AI server (port 8000)
cd ai && source .venv/bin/activate && python server.py

# Backend API (port 3001)
cd /home/user/projects/solana-trading-bot
npx ts-node src/api/server.ts

# Frontend (port 5173)
cd ~/projects/PFE/trading-platform
npm run dev

# E2E test (creates a price gap, runs one tick, asserts)
npx ts-node scripts/devnet/test_e2e_pipeline.ts

# Vault tests including bot_swap CPI
npx ts-node scripts/devnet/test_vault.ts

# Protection integration on real devnet
npx ts-node scripts/devnet/test_protection_integration.ts
```

---

## Manually Creating Real Opportunities

```bash
# Real arb: push a pool out of equilibrium (5000 fUSDC default into pool1)
npx ts-node scripts/devnet/create_arb.ts
npx ts-node scripts/devnet/create_arb.ts pool1 8000

# Real liquidation: register a position. Bot computes health from real pool prices.
npx ts-node scripts/devnet/create_loan.ts \
  --collateralToken=fSOL --collateralAmount=10 \
  --debtToken=fUSDC --debtAmount=1700 --threshold=1.20

npx ts-node scripts/devnet/create_loan.ts --list
npx ts-node scripts/devnet/create_loan.ts --clear

# Seed any wallet with multi-token test capital
npx ts-node scripts/devnet/send_token_to.ts ALL <recipientPubkey>
npx ts-node scripts/devnet/send_token_to.ts fSOL <recipientPubkey> 5
```

---

## Removed (no fake data anywhere)

- 9 hardcoded seeded yields
- 5 hardcoded loan positions (Whale01..05)
- Synthetic dirty-pool arb opportunity
- Fast-path synthetic-liquidation execution that fabricated profit without sending a tx
- Random direction + random volume in MempoolMonitor (now strict — only real readable swaps count)

The bot reports `0 opportunities` when nothing real is happening. Every "Trade executed" line corresponds to a real on-chain Solana signature.

---

## Key Config Files

| File | Purpose |
|---|---|
| `config/settings.yaml` | Network, AI data source, vault program ID, fees, AMM params, protection thresholds, helius/mempool config |
| `config/strategy_params.yaml` | Strategy-specific min profit %, enabled strategies |
| `config/devnet_tokens.json` | fUSDC/fSOL/fRAY mint addresses + bot's ATAs |
| `config/devnet_pools.json` | 4 pool addresses (pool1, pool2, pool3, pool4_dirty) |
| `config/devnet_flash_vault.json` | Flash loan vault PDA addresses |
| `config/devnet_vault.json` | Reference vault PDA from deploy_vault.ts (dev wallet's vault) |
| `config/dev-wallet.json` | DevNet wallet keypair (gitignored) |

---

## UserConfig (per-user, stored in Redis)

```
dailyLimitUsd, maxTradeUsd, tradingHoursStart, tradingHoursEnd,
flashLoans, yieldGaps, liquidations,
chartPatterns, socialBuzz, copyWhales,
useVaultArb, useVaultFlashArb, minProfitMultiplier,
mode (active | viewer | browse)
```

Each user gets one TradingEngine instance + one WhaleTracker (when `whale_tracking.enabled`).

---

## Frontend Cluster Switch

Change one line in `src/lib/cluster.js`:

```js
export const CLUSTER = "mainnet-beta";   // was "devnet"
```

All Explorer links, all tracked tokens (auto-switches to USDC + wSOL), all panels follow.
