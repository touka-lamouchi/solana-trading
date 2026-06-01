# Product Backlog — Solana Trading Bot

Multi-user autonomous trading platform on Solana (DevNet-first, mainnet AI data layer).

The epic ordering mirrors the functional-requirement capability families defined in
**Chapter 3, §3.3.1 (Functional Requirements)**, in the same sequence. Each epic groups the
user stories that realise those requirements, naming the components that implement them.

## Legend

| Field | Meaning |
|---|---|
| **SP** | Story points (1, 2, 3, 5, 8, 13) |
| **Priority** | P0 (blocker) · P1 (high) · P2 (medium) · P3 (low) |
| **Status** | ✅ Done · 🔶 Partial · ⬜ Not started |

---

## EPIC A — Identity and Configuration
*FR family 1. Components: WalletContext, UserRegistry, UserConfig, `POST /users/:id/config`.*

| ID | User Story | Acceptance Criteria | SP | Priority | Status |
|---|---|---|---|---|---|
| A1 | As a user, I want to be identified by my connected Solana wallet public key so I never manage a password | Wallet pubkey is the user identifier end-to-end; no password auth path exists; `UserRegistry` keys every engine/lane by pubkey (WalletContext, UserRegistry) | 5 | P0 | ✅ |
| A2 | As a user, I want a persisted per-user configuration so my strategy choices survive restarts | Config stores strategy toggles, per-trade + daily caps, trading hours, minimum profit multiplier, vault-routing flags; persisted in Redis (UserConfig) | 5 | P0 | ✅ |
| A3 | As a user, I want to update my configuration at runtime without restarting the engine | `POST /users/:id/config` applies changes live; `GET /users/:id/config` reflects them; ProtectionManager picks up drawdown/hours updates without restart | 5 | P0 | ✅ |

---

## EPIC B — Vault and Custody
*FR family 2. Components: programs-vault (create_vault, deposit, withdraw, set_active, authorize_bot); VaultPanel, vault_client.js.*

| ID | User Story | Acceptance Criteria | SP | Priority | Status |
|---|---|---|---|---|---|
| B1 | As a user, I want to create a personal on-chain vault derived from my wallet | Vault PDA derived from seeds `["user_vault", phantom_pubkey]`; `create_vault` succeeds; PDA owns the user's fUSDC/fSOL/fRAY ATAs (programs-vault, VaultPanel) | 8 | P0 | ✅ |
| B2 | As a user, I want to deposit and withdraw funds while staying the sole transfer authority | `deposit`/`withdraw` work; user remains SPL transfer authority over all vault token accounts; profit math `balance − (deposits − withdrawals)` shown in UI (programs-vault, VaultPanel) | 8 | P0 | ✅ |
| B3 | As a user, I want to activate/deactivate my vault | `set_active` toggles vault state; inactive vault blocks bot execution at the vault gate (programs-vault, check_vault node) | 3 | P0 | ✅ |
| B4 | As a user, I want to authorise the bot to trade on my behalf without transferring custody | `authorize_bot` grants the bot signing for vault CPIs only; user keeps custody throughout (programs-vault) | 5 | P0 | ✅ |

---

## EPIC C — Opportunity Detection and Execution
*FR family 3. Components: ArbReactor, findRankedCycles, executeCyclePublic, LiquidationReactor, LendingClient, programs-lending, DecisionModel, safety pipeline, executeDirectionalTradePublic.*

| ID | User Story | Acceptance Criteria | SP | Priority | Status |
|---|---|---|---|---|---|
| C1 | As the bot, I want to detect arbitrage cycles from live AMM pool reserves | ArbReactor builds a fresh TokenGraph from `poolMonitor.getRecords()` each tick; `findRankedCycles()` returns ranked profitable cycles with optimal size (ArbReactor, arb_graph_builder) | 13 | P0 | ✅ |
| C2 | As the bot, I want to execute profitable arb cycles atomically via flash loan or vault capital | `executeCyclePublic` runs generic N-hop flash-loan + sweep; vault routing via `bot_arb` / `bot_arb_via_flash`; pre-flight simulate gate before submit (executeCyclePublic, transaction_builder) | 13 | P0 | ✅ |
| C3 | As the bot, I want to detect liquidation opportunities on loan positions and recompute health from real pool reserves | LiquidationReactor reads loan registry (Redis) / position PDAs (accountSubscribe); health recomputed from live reserves; fires when health factor < threshold (LiquidationReactor, LendingClient) | 8 | P1 | ✅ |
| C4 | As the bot, I want to execute liquidations on-chain when health falls below threshold | `programs-lending` liquidate instruction executes with real custody; routed through execute_liq node (programs-lending, LendingClient) | 8 | P1 | ✅ |
| C5 | As the bot, I want to evaluate AI-driven (slow-path) opportunities through an aggregated AI score before execution | `DecisionModel.computeScore` aggregates 5 sensors into one weighted aiScore + direction; AI-threshold check gates the slow path (decision_model, check_ai_threshold) | 13 | P1 | ✅ |
| C6 | As the bot, I want every slow-path opportunity to pass a multi-stage safety pipeline before any execution | SafetyPipeline S1→S4 runs and stops on first failure; only passing opps reach executeDirectionalTradePublic (safety_pipeline, check_safety, executeDirectionalTradePublic) | 8 | P1 | ✅ |

---

## EPIC D — Protection and Risk Control
*FR family 4. Components: ProtectionManager, fee guard + simulateTransaction gate in TradingEngine.*

| ID | User Story | Acceptance Criteria | SP | Priority | Status |
|---|---|---|---|---|---|
| D1 | As a risk owner, I want per-user protection rules applied to every trade before submission | ProtectionManager enforces slippage limits, daily drawdown, trading-hours window, and auto-pause on consecutive failures on the fast and slow paths (ProtectionManager) | 8 | P0 | ✅ |
| D2 | As a risk owner, I want trades rejected when expected profit doesn't beat the network fee by the configured multiplier | Fee guard skips trades where `expectedProfit < networkFee × minProfitMultiplier` (default 1.5×); emits `trade_rejected` with `reasonCode=fee_guard` (fee guard, TradingEngine) | 5 | P0 | ✅ |
| D3 | As a risk owner, I want any transaction that fails pre-flight simulation to be aborted | `simulateTransaction` runs before submit; revert aborts with `reasonCode=preflight_sim_failed`; no on-chain submission occurs (simulateTransaction gate, TradingEngine) | 5 | P0 | ✅ |

---

## EPIC E — Multi-User Service and Interface
*FR family 5. Components: UserRegistry, UserLane, EventQueue; Express/ws API on port 3001.*

| ID | User Story | Acceptance Criteria | SP | Priority | Status |
|---|---|---|---|---|---|
| E1 | As the platform, I want to serve multiple users concurrently with isolated config, capital, and event processing | Each user owns one TradingEngine + one UserLane; isolation verified under load (UserRegistry, UserLane) | 13 | P0 | ✅ |
| E2 | As the platform, I want each user to own a bounded event queue and a single-threaded consumer loop | EventQueue bounded (256) with per-kind drop policy; single consumer loop per lane; backpressure metrics on `/status` (UserLane, EventQueue) | 8 | P0 | ✅ |
| E3 | As a user, I want a real-time interface for engine control, status, configuration, and trade history over REST | `/users/:id/start|stop`, `/users/:id/status`, `/users/:id/config` (GET/POST), `/users/:id/trades`, `/health`, `/users`, `/market` all served on port 3001 (Express API) | 8 | P0 | ✅ |
| E4 | As a user, I want real-time trade and scan events over WebSocket | `ws://localhost:3001/ws` emits `trade_executed`, `trade_rejected`, `scan_complete` per user; events carry `oppType`, `cyclePath`, `hops`, `reasonCode` (ws API) | 5 | P0 | ✅ |

---

## EPIC F — AI Brain (Signal Layer)
*Supporting the AI-driven detection in Epic C. Components: DecisionModel, AI server, WhaleTracker, MempoolMonitor.*

| ID | User Story | Acceptance Criteria | SP | Priority | Status |
|---|---|---|---|---|---|
| F1 | As the bot, I want 5 sensors aggregated into one weighted decision | `DecisionModel.computeScore` does Promise.all over regime, vol-expansion, sentiment, whale, mempool; returns aiScore + direction + breakdown | 13 | P1 | ✅ |
| F2 | As the bot, I want regime, direction, vol-expansion, and sentiment served by the Python AI server | `/predict/regime`, `/predict/direction`, `/predict/vol-expansion`, `/predict/sentiment` live on port 8000 (Gemini if `GEMINI_API_KEY`, else VADER) | 8 | P1 | ✅ |
| F3 | As the bot, I want whale and mempool sensors reading Solana mainnet directly | WhaleTracker via `getTokenLargestAccounts`; MempoolMonitor via `onLogs` for Raydium V4 + Orca Whirlpool | 8 | P1 | ✅ |

---

## EPIC G — Graph Orchestration (Event Pipeline)
*Underlying execution fabric for Epics C–E. Components: src/graph (events, queue, nodes, build, entries, user_lane).*

| ID | User Story | Acceptance Criteria | SP | Priority | Status |
|---|---|---|---|---|---|
| G1 | As the platform, I want typed events + a bounded queue with per-kind drop policy | Discriminated-union LaneEvent types; queue (256) with drop_oldest / drop_newest / never_drop policies | 8 | P1 | ✅ |
| G2 | As the platform, I want a compiled graph with all nodes + edges reachable | `build.ts` compiles; topology test confirms every node reachable | 13 | P1 | ✅ |
| G3 | As the platform, I want reactors as pure event sources fanning into lanes | ArbReactor + LiquidationReactor enqueue; CandleReactor fans out via one shared Binance WS | 8 | P1 | ✅ |
| G4 | As the platform, I want concurrency hardening + graceful drain | 10s drain timeout on stop; backpressure metrics; backpressure integration test passes | 8 | P1 | ✅ |

---

## EPIC H — Production Arbitrage Rewrite
*Generic, production-grade replacement for the legacy 3-hardcoded-pool detector. Components: pure_code modules, transaction_builder, executeCyclePublic.*

| ID | User Story | Acceptance Criteria | SP | Priority | Status |
|---|---|---|---|---|---|
| H1 | As the bot, I want a graph-based arb detector core | pool_registry, token_graph, cycle_finder (DFS), cycle_simulator, optimal_sizer — pure logic, unit tested | 13 | P1 | ✅ |
| H2 | As the bot, I want a dynamic pool monitor + reactor wiring building cycles each tick | `getRecords()` mint/decimals/fee-aware; `findRankedCycles()`; RankedCycle metadata attached to opportunities | 13 | P1 | ✅ |
| H3 | As the bot, I want a generic N-hop tx builder + executor | `buildCycleArbTransaction` (any hop count) + `executeCyclePublic` / `executeCycleArb` | 13 | P1 | ✅ |
| H4 | As the bot, I want a pre-flight simulate gate + reject reasons + N-token frontend rendering | `reasonCode` / `cyclePath` / `hops` on every detail; `trade_rejected` WS event; LiveCockpit renders any hop count | 8 | P1 | ✅ |

---

## EPIC I — Frontend Dashboard
*User-facing surface for Epics A–E. Components: trading-platform (React + Vite + Solana wallet adapter).*

| ID | User Story | Acceptance Criteria | SP | Priority | Status |
|---|---|---|---|---|---|
| I1 | As a user, I want Phantom connect / browse mode | AuthPage supports Phantom connect and viewer mode | 5 | P1 | ✅ |
| I2 | As a user, I want a Live Cockpit with KPIs, PnL chart, activity log, and signals | LiveCockpit renders KPIs, PnL chart, scrollable activity log, signals; N-token cycle arrows + reasonCode badges | 8 | P1 | ✅ |
| I3 | As a user, I want a Bot Builder to configure detectors, wallet, and vault | BotBuilder hosts detector toggles + WalletPanel + VaultPanel; writes to `/users/:id/config` | 8 | P1 | ✅ |
| I4 | As a user, I want an Analytics Hub with zero static data | AnalyticsHub shows real KPIs, by-strategy breakdown, trade history with Explorer links + route badges | 8 | P1 | ✅ |
| I5 | As a user, I want real Anchor vault calls without an Anchor frontend dependency | vault_client.js builds create/deposit/withdraw instructions via IDL discriminators | 8 | P1 | ✅ |
| I6 | As an operator, I want a one-line cluster flip (devnet ↔ mainnet) | Changing `CLUSTER` in cluster.js switches every panel + Explorer link | 2 | P2 | ✅ |

---

## EPIC J — Yield Strategy
*The remaining detector (currently empty). Components: yield_rate_monitor.ts, detect_yields.ts.*

| ID | User Story | Acceptance Criteria | SP | Priority | Status |
|---|---|---|---|---|---|
| J1 | As the bot, I want a live yield source wired so yield gaps are real | `yield_rate_monitor.ts` + `detect_yields.ts` populated from a live API (e.g. DefiLlama); no hardcoded APYs | 8 | P2 | ⬜ |
| J2 | As a user, I want yield opportunities executable via the vault | Yield opp flows the slow path → `execute_slow` with a real route via `bot_swap` | 5 | P2 | ⬜ |
| J3 | As a developer, I want unit tests for the yield detector | Fixture API response → ranked yield opportunities | 3 | P2 | ⬜ |

---

## EPIC M — (FINISHED — detail to be added later)
*Marked finished per current planning; stories below are best-guess placeholders to be confirmed.*

| ID | User Story | Acceptance Criteria | SP | Priority | Status |
|---|---|---|---|---|---|
| M1 | As an operator, I want a backtest harness replaying historical data through the graph offline | Historical candles + pool states replay through the pipeline without live RPC | 13 | P2 | ✅ |
| M2 | As an analyst, I want per-strategy PnL attribution persisted over time | Historical rollups beyond today's trades, broken down by strategy | 8 | P2 | ✅ |
| M3 | As an operator, I want an observability dashboard for queue depth, drop rate, and latency | Metrics exported and visualised; backpressure metrics from `/status` scraped | 8 | P2 | ✅ |
