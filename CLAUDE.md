# Solana Trading Bot

Multi-user autonomous trading platform on Solana. DevNet-first, with mainnet data sources wired for the AI signal layer.
TypeScript engine + Python AI server + 3 deployed Anchor programs + React frontend.

## Architecture Overview

Two repos:
- **Backend:** `/home/user/projects/solana-trading-bot` — engine, API server, Anchor programs, scripts
- **Frontend:** `/home/user/projects/PFE/trading-platform` — React + Vite + Solana wallet adapter

## How the bot works

The bot is event-driven. There is no central polling tick. Each user gets a `UserLane` — a bounded FIFO queue + single-threaded consumer loop that invokes a LangGraph graph.

### Single-user mode
`src/main.ts` boots one `TradingEngine` and runs `engine.startLoop(10_000)` (legacy poll mode, no graph).

### Multi-user mode (current — API server)
`src/api/server.ts` runs Express + WebSocket on port 3001. `UserRegistry` creates one `TradingEngine` + one `UserLane` per connected user. Events flow from three sources into the lane queue:

1. **ArbReactor** — fires on every pool reserve change; enqueues `arb_opportunity`
2. **LiquidationReactor** — fires on every pool reserve change; enqueues `liq_opportunity`
3. **CandleReactor** (shared, one Binance WS) — fires on each 1-min close; fans out `candle_closed` to all active lanes
4. **SignalsTimer** — `setInterval(5000)` inside each lane; enqueues `signals_timer`

### What the graph does per event

```
signals_timer → full discovery subgraph:
  scan_pools → [detect_arbs, detect_yields, detect_liquidations, ingest_candles]
  ingest_candles → ai_decision → [detect_chart_pattern, detect_social_buzz,
                                   detect_whale_copy, detect_mempool_pressure,
                                   build_directional]
  → filter_by_config → pick_next (loop) → route → fast or slow path → build_summary
  (route is two-way: fast | slow. Liquidation rides the fast tail, dispatched
   to execute_liq by opp type after check_vault — see "Fast path" below.)

arb_opportunity / liq_opportunity → fast execution tail only:
  pre-populates filteredOpportunities → pick_next → route → fast path
  (liq dispatched to execute_liq inside the fast tail by opp type)

candle_closed → AI refresh + signal detectors:
  same as signals_timer (short-circuits discovery if poolStates absent)
```

### Fast path (arb + liquidation)
Routing is **two-way** (`route` returns `"fast" | "slow"`). Liquidation is NOT a
top-level path — it is a sub-branch of fast, dispatched by `opp.arb.type` *after*
the shared protection + vault checks (`afterVault` conditional edge in build.ts):
```
log_whale_signals → check_guard_fast → check_vault → ┬─ (type==="liquidation") → execute_liq  → pick_next
                                                     └─ (else / arbitrage)      → execute_fast → pick_next
```
`log_whale_signals` is informational telemetry only — it gates nothing.

### Slow path (yield, directional, chart_pattern, social_buzz, copy_whale, mempool_pressure)
```
check_ai_threshold → check_safety → log_whale_signals → check_guard_slow → execute_slow → pick_next
```

### Trade execution paths

| Opportunity type | Default path | Custody | Notes |
|---|---|---|---|
| Triangular arb | flash-loan via bot wallet + sweep profit to vault | bot transit, profit lands in vault | Phase 3 sweep step (atomic) |
| Triangular arb (`useVaultFlashArb=true`) | `vault.bot_arb_via_flash` (nested CPI: borrow→swap×3→repay) | vault PDA throughout | Phase 4 — no bot transit at all |
| Triangular arb (`useVaultArb=true`) | `vault.bot_arb` using vault capital, no flash loan | vault PDA throughout | Limited to vault balance |
| Slow path (yield, directional, chart_pattern, social_buzz, copy_whale, mempool_pressure) | `vault.bot_swap` CPI to AMM | vault PDA throughout | Bot only signs the outer tx |
| Liquidation | not executable yet | — | Logged with reason; would need a real lending program |

Fee guard: before submitting any flash arb, the engine estimates network fees (priority fee × CU + base fee × $SOL) and skips trades where `expectedProfit < networkFee × minProfitMultiplier` (default 1.5×). Prevents losses on tiny gaps.

Per-trade cap precedence: `min(userConfig.maxTradeUsd, settings.capital.flash_loan_max_usd, opp.amountIn)` — the smallest wins. Depositing more + raising your per-user max actually scales borrow size.

## Deployed Anchor programs (devnet)

| Program | ID | Instructions |
|---|---|---|
| AMM | `CzpMFPxKuL2qSXiZUGmYEdY6LSbD1zdmK25ZNpjukR9K` | initialize_pool, add_liquidity, swap |
| Flash loan | `57qgGcR2anVG58VLymRe1vyui2eUjtefFPmsYFUN3acH` | flash_borrow, flash_repay (skips top-level introspection when borrower is a PDA owned by the vault program) |
| User vault | `Gw6USbf98yEjLLFa9aTeNpQjAvRjuZ2576AVvu3B1g6H` | create_vault, deposit, withdraw, set_active, authorize_bot, **bot_swap** (single-hop CPI to AMM with vault PDA as authority), **bot_arb** (3-hop with vault capital), **bot_arb_via_flash** (nested CPI: flash_borrow → swap×3 → flash_repay all under vault PDA) |

Per-user vault PDA seeds: `["user_vault", phantom_pubkey]`. Each user has their own PDA, owns their fUSDC/fSOL/fRAY ATAs, and is the SPL transfer authority for everything inside.

## AI brain

5 sensors → 1 weighted aggregator → 1 decision.

| Sensor | Where it runs | What it returns | Real data on devnet? |
|---|---|---|---|
| LSTM regime (XGBClassifier) | Python AI server `/predict/regime` | trending/ranging/crash | yes (mainnet candle data via IngestionService) |
| GRU vol-expansion (Keras) | Python AI server `/predict/vol-expansion` | expansion probability | yes |
| Sentiment | Python AI server `/predict/sentiment` (Reddit + Gemini 2.0 Flash if `GEMINI_API_KEY`, else VADER) | score [-1, +1], volume | yes (queried for wSOL on mainnet) |
| Whale | TS WhaleTracker → Solana mainnet `getTokenLargestAccounts` | accumulating/distributing/holding + confidence | yes (wSOL whales tracked every 60s) |
| Mempool | TS MempoolMonitor → Solana mainnet RPC `onLogs` for Raydium V4 + Orca Whirlpool | buy/sell pressure score [-1, +1] | yes |

The aggregator (`DecisionModel.computeScore`) does Promise.all over the 5, normalizes each to [0,1], applies user-configurable weights, returns one `aiScore` + `direction` + signal breakdown. **One brain, five sense organs.**

## Signal/trade bridge (devnet)

When `ai.data_source: "mainnet"`, AI signals are populated under the **mainnet** mint key (e.g., wSOL `So11...112`). The 4 AI-driven detectors look up signals using the mainnet mint, but emit opportunities that **execute against your devnet pool1** (fUSDC/fSOL). Real signal → real on-chain devnet trade.

## Project structure

```
src/
  engine/
    trading_engine.ts          # executeTriangularArbPublic (legacy 3-hop) +
                               # executeCyclePublic (Production Arb Phase 3 —
                               # generic N-hop, consumes opp.cycle.simulation) +
                               # executeDirectionalTradePublic +
                               # executeLiquidationPublic.
                               # startReactors() (API mode) + startLoop() (single-user).
                               # exposeDetectors() for EngineDeps wiring.
                               # Fee guard + per-trade cap precedence + signal/trade bridge.
                               # Production Arb Phase 4: pre-flight simulateTransaction
                               # gate before submit (aborts with reasonCode=preflight_sim_failed
                               # on revert); structured reasonCode + cyclePath + hops
                               # on every TickDetail return.
    arb_reactor.ts             # Subscribes to PoolMonitor. Builds a fresh
                               # TokenGraph from poolMonitor.getRecords() each
                               # tick, runs findRankedCycles() (graph-based
                               # arbitrage finder), enqueues the best cycle as
                               # arb_opportunity. Carries `cycle` metadata
                               # (RankedCycle) for the Phase 3 generic executor;
                               # legacy `poolStates / involvedMints / poolKeys`
                               # also populated so the Phase 1 executor still works.
    liquidation_reactor.ts     # Subscribes to PoolMonitor; enqueues liq_opportunity events
  main.ts                      # Single-user boot (legacy poll mode, no graph)
  api/
    server.ts                  # Express + WebSocket on :3001
    user_registry.ts           # Per-user TradingEngine + UserLane + WhaleTracker
                               # Wires reactors → lane; CandleReactor fans out to all lanes
                               # Exposes queue backpressure metrics on /status
    user_config.ts             # UserConfig + Redis storage
  graph/                       # LangGraph orchestration layer (Phases 0–5, COMPLETE)
    events.ts                  # Discriminated-union LaneEvent types + EventKind
    queue.ts                   # EventQueue — bounded (256), FIFO, per-kind drop policy
                               # drop_oldest: pool_changed, mempool_pressure, signals_timer
                               # drop_newest: arb_opportunity, liq_opportunity
                               # never_drop: candle_closed
    deps.ts                    # EngineDeps — single object every graph node receives
    state.ts                   # Annotation.Root graph state shape
    build.ts                   # Wires all nodes + edges; returns CompiledGraph
    entries.ts                 # signalsEntry / candleEntry / arbEntry / liqEntry
    user_lane.ts               # UserLane — owns queue + consumer loop + signals timer
                               # dispatch() routes each event kind to the right entry
                               # stop() drains with 10s timeout then force-disposes
    nodes/
      discovery/
        scan_pools.ts          # Reads pool reserves from PoolMonitor
        detect_arbs.ts         # Triangular arb math
        detect_yields.ts       # Empty (DefiLlama not wired)
        detect_liquidations.ts # Reads loan registry from Redis + real prices
        ingest_candles.ts      # Pulls latest candles from IngestionService
        ai_decision.ts         # Runs DecisionModel.computeScore (5 signals)
        detect_chart_pattern.ts
        detect_social_buzz.ts
        detect_whale_copy.ts
        detect_mempool_pressure.ts
        build_directional.ts   # Builds directional opp from AI decision
        filter_by_config.ts    # Applies user config toggles
      execution/
        pick_next.ts           # Pops first from remainingOpportunities
        route.ts               # fast vs slow via OpportunityRouter (two-way only;
                               # liquidation routes to "fast" and is dispatched to
                               # execute_liq by opp type after check_vault)
        log_whale_signals.ts   # Logs whale + mempool context before execution
        check_guard_fast.ts    # ProtectionManager.canExecuteTrade (fast path)
        check_vault.ts         # VaultReader balance gate
        execute_fast.ts        # When opp.cycle is set and user isn't on a vault-routed
                               # path: engine.executeCyclePublic (generic N-hop).
                               # Otherwise: engine.executeTriangularArbPublic (legacy).
        check_ai_threshold.ts  # aiScore gate for slow path
        check_safety.ts        # SafetyPipeline S1→S4
        check_guard_slow.ts    # ProtectionManager.canExecuteTrade (slow path)
        execute_slow.ts        # engine.executeDirectionalTradePublic
        build_summary.ts       # Assembles TickResult from state.details
        emit_status.ts         # wsEmit(scan_complete) to WebSocket listeners
      utils.ts
  layer1_opportunity/
    pure_code/
      arbitrage_detector.ts    # Legacy triangular arb math (3 hardcoded pools).
                               # Being replaced by graph-based detector below
                               # (Phase 1 of production rewrite — see Production Arbitrage).
      pool_registry.ts         # PoolRegistry — in-memory cache of all known
                               # pools, keyed by PDA. Pure logic.
      token_graph.ts           # TokenGraph — adjacency map keyed by mint;
                               # bidirectional pool edges with reserves +
                               # decimals oriented per direction.
      cycle_finder.ts          # findCycles(graph, baseMint, {min,maxDepth}) —
                               # DFS enumeration of closed cycles starting and
                               # ending at base. Both traversal directions kept.
      cycle_simulator.ts       # simulateCycle(edges[], amountIn) — exact
                               # constant-product walk with per-pool fees.
                               # Returns null on broken / non-closed cycles.
      optimal_sizer.ts         # findOptimalSize(cycle, opts) — ternary search
                               # for amountIn maximizing net profit; rejects
                               # if margin doesn't clear minProfitMultiplier × fee.
      arb_graph_builder.ts     # buildGraph(pools[]) + findRankedCycles(pools, opts)
                               # → ranked profitable cycles, each with optimal
                               # amountIn + simulator output. Pure logic. This
                               # is what ArbReactor calls every pool tick.
      liquidation_hunter.ts    # Reads loan registry from Redis,
                               # applyPrices() updates from real pool reserves
      yield_rate_monitor.ts    # Empty until DefiLlama is wired
    safety_filters/
      safety_pipeline.ts       # S1→S4 chain (stops on first fail)
      s1_onchain_heuristics.ts
      s2_honeypot_detector.ts
      s3_isolation_forest.ts
      s4_anomaly_detection.ts
    opportunity_router.ts
    whale_tracker.ts           # Mainnet RPC scan when ai.data_source=mainnet
    ai_signals/
      lstm_signal.ts           # → /predict/regime + /predict/direction
      sentiment_signal.ts      # → /predict/sentiment (Reddit + VADER/Gemini)
      whale_signal.ts          # Reads WhaleCache
      mempool_signal.ts        # Reads MempoolMonitor pressure
      chart_pattern_detector.ts
      social_buzz_detector.ts
      whale_copy_detector.ts
      mempool_pressure_detector.ts
    decision_model.ts          # 5-signal Promise.all + weighted aggregation
  layer2_execution/
    route_planner.ts
    transaction_builder.ts     # 6 builders:
                               #   buildSwapTransaction (raw AMM)
                               #   buildFlashLoanArbTransaction (legacy, hardcoded
                               #     to 3-hop SwapRoute)
                               #   buildCycleArbTransaction (Production Arb Phase 3:
                               #     generic over hop count, walks PoolEdge cycles)
                               #   buildVaultSwapTransaction (vault.bot_swap CPI)
                               #   buildVaultArbTransaction (vault.bot_arb)
                               #   buildVaultArbViaFlashTransaction (vault.bot_arb_via_flash)
    fee_calculator.ts
    sandwich_detector.ts
    volatility_predictor.ts    # → /predict/vol-expansion
  layer3_protection/
    tx_submitter.ts
    hard_slippage_limits.ts
    jito_mev_protection.ts
    auto_pause.ts
    daily_drawdown.ts
  protection/                  # Pure TS, no Solana deps
    protection_manager.ts      # auto-pause + drawdown + slippage + hours + vault
    auto_pause.ts
    drawdown.ts
    slippage_guard.ts
    trading_hours.ts
  vault/
    vault_reader.ts            # Per-user vault PDA reader + IDL Program
                               # exposes balance, isActive, totalDeposits/Withdrawals
                               # plus getVaultProgram() for the engine
  cache/
    cache_manager.ts
    sentiment_cache.ts
    whale_cache.ts
    lstm_cache.ts
    token_score_cache.ts
    ema_tracker.ts
  infrastructure/
    solana_rpc.ts
    mainnet_rpc.ts             # Mainnet read-only RPC for AI sensors
    mempool_monitor.ts         # onLogs(Raydium V4, Orca Whirlpool) on mainnet
                               # writes pressure to Redis (no synthetic injection)
    pool_monitor.ts            # accountSubscribe on all pool vault accounts.
                               # Notifies ArbReactor + LiquidationReactor on
                               # reserve changes. getRecords() returns
                               # PoolRecord[] (mint-aware, decimals-aware,
                               # fee-aware) for the graph-based arb finder.
    candle_reactor.ts          # Binance WebSocket 1-min candles; emits candle_closed
    dex_listener.ts
  ingestion/
    ingestion_service.ts       # Fetches mainnet candles (Binance) + Pyth ticks
                               # for the AI server's feature window
    candle_fetcher.ts
    price_feeds/pyth_feed.ts
  models/
    model_server.ts            # AI server HTTP client
  utils/
    config.ts                  # getConfig() / getStrategyConfig() — singleton YAML
    wallet.ts
    logger.ts
    metrics.ts

config/
  settings.yaml               # All bot settings + ai.data_source + helius/mempool sections
  strategy_params.yaml
  devnet_tokens.json
  devnet_pools.json
  devnet_dirty_tokens.json
  devnet_flash_vault.json
  devnet_vault.json           # Reference vault PDA from deploy_vault.ts (dev wallet)
  dev-wallet.json             # gitignored

programs-amm/                 # AMM Anchor program
programs-protection/          # Flash loan Anchor program (vault PDA borrowers supported)
programs-vault/               # Per-user vault Anchor program (deployed)

scripts/devnet/
  README.md                   # "I want to test X → run Y" map
  setup/                      # One-time devnet bring-up, run in numeric order
    01_create_tokens.ts
    02_revoke_mint.ts
    03_create_pools.ts
    04_create_dirty_tokens.ts
    05_create_dirty_pool.ts
    06_setup_flash_vault.ts
    07_deploy_vault.ts        # Bot wallet's reference vault
    populate_caches.ts        # Re-run after every Redis restart
  trigger/                    # Create real activity for the live bot
    create_arb.ts             # Push a pool out of equilibrium → real arb
    create_loan.ts            # Register a loan position in Redis
                              # --list / --clear / --delete=<id> for management
    send_token_to.ts          # Generalized fUSDC/fSOL/fRAY/ALL sender
  archive/                    # Stale or superseded — kept for reference
    simulate_arb.ts, simulator.ts, test_transaction.ts, check_mints.ts

tests/
  unit/
    test_detectors.ts, test_safety.ts, test_swap.ts, test_flash_loan.ts,
    test_vault.ts, test_protection.ts, test_protection_offchain.ts,
    test_cache_latency.ts
    test_graph_topology.ts    # Graph compiles + all nodes reachable (no Solana deps)
    test_lane_inert.ts        # Lane starts/stops cleanly with no events
  integration/
    test_e2e_pipeline.ts      # Full tick test
    test_full_trade.ts
    test_flash_vault_atomicity.ts
    test_protection_integration.ts
    test_phase9.ts
    test_graph_arb.ts         # fixture pool change → arb event → trade executed
    test_graph_liquidation.ts # fixture loan + price drop → liq detected
    test_lane_backpressure.ts # flood queue → drop policy + user isolation
  backtests/                  # (empty — future)

ai/
  server.py                   # FastAPI: /predict/regime, /predict/direction,
                              # /predict/sentiment, /predict/vol-expansion
  sentiment.py                # Reddit fetcher + VADER scorer
  models/                     # Pickled XGBClassifier + Keras GRU
```

## Frontend

Location: `/home/user/projects/PFE/trading-platform`

```
src/
  main.jsx                    # Entry — Buffer polyfill + React root
  App.jsx                     # Shell — auth, nav, bot start/stop, polled SOL balance
  pages/
    AuthPage.jsx              # Phantom connect / browse mode
    LiveCockpit.jsx           # KPIs + PnL chart + scrollable activity log + signals
    BotBuilder.jsx            # My Setup — WalletPanel + VaultPanel + detector toggles
    AnalyticsHub.jsx          # Results — real KPIs from useEngineData,
                              # cumulative PnL chart, daily activity bars,
                              # by-strategy breakdown, trade history table with
                              # Solana Explorer links and "Vault PDA / Flash + sweep"
                              # route badges. ZERO static data.
    LLMAdvisor.jsx            # Stub
    AITuning.jsx              # Stub
  components/
    WalletPanel.jsx           # Phantom address + tracked SPL token balances
                              # + Vault holdings sub-section (vault PDA's ATAs —
                              # this is where bot profits visibly land)
                              # + recent activity (last 10 sigs → Explorer)
    VaultPanel.jsx            # Real Anchor calls: createVault, deposit, withdraw
                              # using IDL discriminators (no Anchor frontend dep)
                              # Profit tile = balance - (deposits - withdrawals)
  context/
    ThemeContext.jsx
    WalletContext.jsx         # Phantom + Solflare adapter, devnet RPC
  hooks/
    useEngineData.js          # Polls /status (5s), /trades (30s), WS subscription
                              # Module-level cache survives tab unmount/remount
                              # Trade dedup by signature (prevents drift)
  lib/
    api.js                    # REST + WebSocket client
    vault_client.js           # Manual Anchor instruction builders for createVault,
                              # deposit, withdraw + getVaultBalance, getVaultStats,
                              # vaultExists, formatVaultError
    cluster.js                # Single source of truth for CLUSTER, EXPLORER URLs,
                              # TRACKED_TOKENS (fUSDC/fSOL/fRAY on devnet,
                              # USDC/wSOL on mainnet — flip one constant to switch)
  styles.css
  vite.config.js              # vite-plugin-node-polyfills for Buffer/process
```

### Frontend ↔ Backend API

| Endpoint | Method | Purpose |
|---|---|---|
| `/health` | GET | Server health |
| `/users` | GET | List active users |
| `/users/:userId/start` | POST | Start engine |
| `/users/:userId/stop` | POST | Stop engine |
| `/users/:userId/status` | GET | KPIs, protection, vault (balance, profit, deposits, withdrawals), AI |
| `/users/:userId/config` | GET/POST | Read/write user config |
| `/users/:userId/trades` | GET | Today's executed trades from Redis |
| `/market` | GET | Viewer-mode market snapshot |
| `ws://localhost:3001/ws` | WS | Per-user tick events (trade_executed, scan_complete, …) |

WebSocket trade events include `oppType` so the frontend can render the right type badge + route badge.

Production Arbitrage Phase 4 adds three more fields to every `trade_executed` and the new `trade_rejected` event:
- `cyclePath: string[]` — token symbols including the start, e.g. `["fUSDC","fSOL","fRAY","fUSDC"]`. Used by LiveCockpit to render arrows for any hop count (no longer assumes 3).
- `hops: number` — hop count of the cycle.
- `reasonCode: string` — machine-readable code for failures: `fee_guard | preflight_sim_failed | flash_config_missing | tx_build_failed | tx_rejected | missing_cycle`. Frontend shows the code in `[brackets]` next to the human reason.

### UserConfig fields

`dailyLimitUsd`, `maxTradeUsd`, `tradingHoursStart/End`, `flashLoans`, `yieldGaps`, `liquidations`, `chartPatterns`, `socialBuzz`, `copyWhales`, `useVaultArb`, `useVaultFlashArb`, `minProfitMultiplier`, `mode`.

## Phase status (current snapshot)

| Phase | Status |
|---|---|
| 1 Infrastructure | DONE |
| 2 DevNet simulation | DONE |
| 3 Redis cache layer | DONE |
| 4 Opportunity detectors (7) | DONE — all real data, no synthetic seeds |
| 5 Safety filters | DONE |
| 6 Anchor programs (3) | DONE + per-user vault deployed |
| 7 Execution layer | DONE — 5 transaction builders incl. vault-routed |
| 8 AI server | DONE — 4 endpoints live (regime, direction, sentiment, vol-expansion) |
| 9 Protection | DONE + vault wiring + fee guard |
| 10 RWA | CANCELLED |
| 11 Trading engine loop | DONE |
| 12 Mainnet preparation | PARTIAL — AI signals already on mainnet data, trading still on devnet |
| 13 Frontend dashboard | DONE — all panels real-data wired, vault custody visible |
| Graph Phase 0 — Event types + queue contract | DONE |
| Graph Phase 1 — Graph definition (all nodes + edges) | DONE |
| Graph Phase 2 — Per-user UserLane + consumer loop | DONE |
| Graph Phase 3 — Signal detectors through graph | DONE — signals_timer → full discovery |
| Graph Phase 4 — Reactors as pure event sources | DONE — ArbReactor + LiquidationReactor enqueue; CandleReactor fans out |
| Graph Phase 5 — Concurrency hardening | DONE — bounded queue, drop policy, metrics on /status, drain/stop, integration tests |
| Graph Phase 6 — Honest liquidation | DONE — programs-lending Anchor program, LendingClient, execute_liq node, accountSubscribe reactor |
| Production Arbitrage Phase 1 — Graph-based detector core | DONE — pool_registry, token_graph, cycle_finder (DFS), cycle_simulator, optimal_sizer + 27 unit tests passing |
| Production Arbitrage Phase 2 — Dynamic pool monitor + reactor wiring | DONE — pool_monitor.getRecords(), arb_graph_builder.findRankedCycles(), arb_reactor rewritten to graph-based finder. RankedCycle metadata attached to DiscoveredOpportunity for Phase 3. Legacy positional executor still works (pre-Phase-3). 32 unit tests passing |
| Production Arbitrage Phase 3 — Generic N-hop tx builder + executor | DONE — TransactionBuilder.buildCycleArbTransaction (any hop count, derives a_to_b per edge), TradingEngine.executeCyclePublic + private executeCycleArb (flash-loan + sweep), graph execute_fast routes to it when opp.cycle is set and user isn't on vault-routed paths. Legacy executor preserved as fallback. 37 unit tests passing |
| Production Arbitrage Phase 4 — Pre-flight simulate gate + reject reasons + frontend cycle render | DONE — TickDetail carries reasonCode (machine-readable) + cyclePath + hops; executeCycleArb runs simulateTransaction before submit and aborts with `preflight_sim_failed` reasonCode if it fails; user_registry emits the new fields in WS events as a `trade_rejected` type for failed cycles; LiveCockpit renders generic N-token cycle paths and surfaces reasonCode badges in the activity log; useEngineData stores cyclePath + hops on persisted trades. 37 unit tests still passing |
| 14 Production deployment | NOT STARTED |

## Removed (no fake data anywhere)

- Hardcoded seeded yields (9 fake APYs) — gone
- Hardcoded loan positions (5 Whale01..05) — gone
- Synthetic dirty-pool arb opportunity (`expectedProfit: 0` filler) — gone
- Synthetic-liquidation execution branch that fabricated profit without sending a tx — gone
- Random direction/volume injection in MempoolMonitor — gone (only counts swaps with explicit direction + numeric volume)

The bot reports `0 opportunities` when nothing real is happening. Every "Trade executed" line corresponds to a real on-chain signature.

## DevNet setup & testing

```bash
# One-time per Redis restart
redis-server --daemonize yes
npx ts-node scripts/devnet/setup/populate_caches.ts

# Optional one-time (already done if config files exist)
npx ts-node scripts/devnet/setup/02_revoke_mint.ts
npx ts-node scripts/devnet/setup/05_create_dirty_pool.ts

# AI server
cd ai && source .venv/bin/activate && python server.py        # :8000

# API server
cd /home/user/projects/solana-trading-bot
npx ts-node src/api/server.ts                                  # :3001

# Frontend
cd ~/projects/PFE/trading-platform
npm run dev                                                    # :5173

# Single-user mode
npx ts-node src/main.ts

# E2E test
npx ts-node tests/integration/test_e2e_pipeline.ts
```

## Manually creating real opportunities

```bash
# Push a pool out of equilibrium → triangular arb fires next tick
npx ts-node scripts/devnet/trigger/create_arb.ts                      # 5000 fUSDC into pool1
npx ts-node scripts/devnet/trigger/create_arb.ts pool1 8000           # custom amount/pool

# Register a loan position in the Redis registry
npx ts-node scripts/devnet/trigger/create_loan.ts \
  --collateralToken=fSOL --collateralAmount=10 \
  --debtToken=fUSDC --debtAmount=1700 --threshold=1.20

# Bot reads from Redis, computes health from REAL pool reserves on the next tick
# Health < threshold → LIQUIDATION FOUND → real swap execution

# Manage the registry
npx ts-node scripts/devnet/trigger/create_loan.ts --list
npx ts-node scripts/devnet/trigger/create_loan.ts --clear
npx ts-node scripts/devnet/trigger/create_loan.ts --delete=<id>

# Seed any wallet with test tokens (multi-token)
npx ts-node scripts/devnet/trigger/send_token_to.ts ALL <pubkey>      # 1000 fUSDC + 5 fSOL + 200 fRAY
npx ts-node scripts/devnet/trigger/send_token_to.ts fSOL <pubkey> 5
```

## DevNet config gotchas

`settings.yaml` thresholds that change for mainnet:

| Setting | DevNet | Mainnet | Why |
|---|---|---|---|
| `max_dev_wallet_pct` | 100 | 20 | We minted all tokens |
| `wash_trading_top2_threshold` | 1.0 | 0.95 | Top 2 holders = us + pool on devnet |
| `min_unique_holders` | 1 | 10+ | Few holders on devnet |
| `ai.data_source` | `mainnet` | `mainnet` | Already on mainnet for signals |
| `ai.target_mint_mainnet` | `wSOL` | `wSOL` (or whatever target) | Drives WhaleTracker + MempoolMonitor + sentiment |

Frontend cluster flip: change one line in `src/lib/cluster.js` (`CLUSTER = "mainnet-beta"`) and every panel/explorer link follows.

## Key patterns

- `getConfig()` / `getStrategyConfig()` — singleton YAML loaders, never import yaml directly
- `loadWallet()` — loads from `config/dev-wallet.json`
- fUSDC (tokenA) is the base token — always trusted, never safety-checked
- Token mints resolved from pool config or by name in `devnet_tokens.json`
- AMM formula: `output = (in × 997 × reserveOut) / (reserveIn × 1000 + in × 997)`
- Vault PDA seeds: `["user_vault", phantom_pubkey]`
- Profit math (frontend): `vault_balance - (totalDeposits - totalWithdrawals)`
- Frontend needs `vite-plugin-node-polyfills` for Buffer/process
- Frontend `dailyLossLimit` (UI) = backend `dailyLimitUsd`

## Two protection folders (intentional)

- `src/protection/` — Pure logic, no Solana deps
- `src/layer3_protection/` — Solana wrappers around `src/protection/`
- `ProtectionManager` supports runtime updates: `updateDrawdownLimit()`, `updateTradingHours()`, holds optional `vaultReader` for `getEffectiveCapital()`

## Environment

- WSL Ubuntu paths: `/home/user/projects/...`
- Windows access: `\\wsl.localhost\Ubuntu\...`
- `npx tsc --noEmit` from inside WSL only
- Anchor builds: `cd programs-X && anchor build && anchor deploy --provider.cluster devnet`
- Anchor preserves program IDs across upgrades when the upgrade authority signs
