# Solana Trading Bot

14-phase autonomous trading bot. DevNet-first, Mainnet-last.
TypeScript + Python AI server + Anchor smart contracts.

## How the Bot Works

The bot brain is `src/engine/trading_engine.ts`. It has ONE method: `tick()`.

`src/main.ts` boots infrastructure (Solana RPC, Redis, AI server, Anchor programs), creates a `TradingEngine`, then calls `engine.startLoop(10_000)` — which runs `tick()` every 10 seconds forever until Ctrl+C.

### What happens each tick

```
Phase A: DISCOVER
  Read ALL pool reserves from on-chain vaults
  ArbitrageDetector.scan() → find triangular arb profit (constant-product formula)
  Also check every non-triangular pool (dirty pools etc.) as synthetic opportunity
  → Collect everything into ONE array

Phase B: EXECUTE (loop through each opportunity in FIFO order)
  For each opportunity:
    1. Extract token mints from pool config
    2. SafetyPipeline.check(mint) — runs S1→S2→S3→S4 in sequence:
       S1: on-chain heuristics (mint authority revoked? dev wallet < threshold?)
       S2: honeypot detection (can we actually sell this token?)
       S3: isolation forest (Redis cached anomaly score < 0.7?)
       S4: anomaly detection (holder count, wash trading pattern)
       → If ANY stage fails → log + SKIP → next opportunity
    3. OpportunityRouter.route() → classify as "fast" or "slow"
       fast = flash loan arb/liquidation (0 own capital)
       slow = yield farming (own capital, needs AI — Phase 8 not done)
    4. ProtectionManager.canExecuteTrade(0)
       Checks: auto-pause (not paused?), trading hours (ok?), drawdown (within limit?)
       → If blocked → log + SKIP → next opportunity
    5. Build flash loan tx → TxSubmitter.submit() → record profit
       flash_borrow → 3 AMM swaps → flash_repay (all atomic, one tx)
```

Guards fire INSIDE the opportunity loop. A dirty token gets rejected at step 2, then the engine moves to the next opportunity naturally.

### Fast path vs slow path

| Opportunity Type | Path | Why |
|---|---|---|
| Arbitrage | fast | Flash loan — borrow→swap→repay atomically, 0 own capital |
| Liquidation | fast | Same atomic flash loan pattern |
| Yield farming | slow | Uses own capital, needs AI confirmation (Phase 8 not done) |

Fast path: skip drawdown check (capitalRequired = 0), execute immediately.
Slow path: blocked until Phase 8 AI models exist.

## Project Structure

```
src/
  engine/
    trading_engine.ts          # THE BOT BRAIN — tick() method
  main.ts                      # Boot + engine.startLoop()
  layer1_opportunity/
    pure_code/
      arbitrage_detector.ts    # Reads pool reserves, calculates arb profit
      liquidation_hunter.ts    # Watches undercollateralized positions
      yield_rate_monitor.ts    # Monitors yield differentials
    safety_filters/
      safety_pipeline.ts       # Runs S1→S2→S3→S4, stops on first fail
      s1_onchain_heuristics.ts # Mint authority, dev wallet %, token age
      s2_honeypot_detector.ts  # Simulates sell via pool existence check
      s3_isolation_forest.ts   # Redis-cached anomaly score
      s4_anomaly_detection.ts  # Holder count, wash trading detection
    opportunity_router.ts      # arb→fast, liquidation→fast, yield→slow
    ai_signals/                # EMPTY STUBS — Phase 8 dependency
      lstm_signal.ts
      sentiment_signal.ts
      whale_signal.ts
    decision_model.ts          # EMPTY — Phase 8 dependency
  layer2_execution/
    route_planner.ts           # Plans single-hop or triangular swap routes
    transaction_builder.ts     # Builds AMM swap + flash loan txs, signs+sends
    fee_calculator.ts          # Priority fees, % of profit cap
    sandwich_detector.ts       # MEV pre-check
    slippage_optimizer.ts      # STUB — needs Phase 8 AI
    volatility_predictor.ts    # STUB — needs Phase 8 AI
  layer3_protection/
    tx_submitter.ts            # THE FINAL GATE — canExecuteTrade() then send
    hard_slippage_limits.ts    # Simulates tx on-chain before submitting
    jito_mev_protection.ts     # Jito bundle submission (dry-run on devnet)
    auto_pause.ts              # Wraps core, cancels slow-path queue on pause
    daily_drawdown.ts          # Wraps core, emits EventEmitter on limit hit
  protection/                  # CORE LOGIC (pure TS, no Solana deps)
    protection_manager.ts      # Orchestrates: auto-pause + drawdown + slippage + hours
    auto_pause.ts              # Consecutive failure counter
    drawdown.ts                # Daily capital tracker
    slippage_guard.ts          # Min acceptable output calculator
    trading_hours.ts           # Time window enforcer
  cache/
    cache_manager.ts           # Redis connection (CacheManager)
    sentiment_cache.ts
    whale_cache.ts
    lstm_cache.ts
    token_score_cache.ts       # S3 reads anomaly scores from here
    ema_tracker.ts
  infrastructure/
    solana_rpc.ts              # Connection + slot subscription
    dex_listener.ts            # EMPTY STUB
    mempool_monitor.ts         # EMPTY STUB
  models/
    model_server.ts            # AI server health check client
  utils/
    config.ts                  # getConfig() / getStrategyConfig() — singleton YAML loaders
    wallet.ts                  # loadWallet() from JSON keypair
    logger.ts                  # Pino structured logger
    metrics.ts                 # Prometheus metrics

config/
  settings.yaml               # ALL bot settings (no hardcodes in source)
  strategy_params.yaml         # Strategy-specific params
  devnet_tokens.json           # Token mints: tokenA=fUSDC, tokenB=fSOL, tokenC=fRAY
  devnet_pools.json            # Pool addresses: pool1-3 clean, pool4_dirty
  devnet_dirty_tokens.json     # Dirty token mints for e2e testing
  devnet_flash_vault.json      # Flash loan vault PDA addresses
  dev-wallet.json              # DevNet wallet keypair (gitignored)

programs-amm/                  # Anchor program — deployed on devnet
  programs/programs-amm/src/lib.rs   # swap, add_liquidity, remove_liquidity

programs-protection/           # Anchor program — deployed on devnet
  programs/programs-protection/src/lib.rs  # flash_borrow, flash_repay, update_vault
  # flash_borrow enforces flash_repay in same tx via instruction introspection

scripts/devnet/
  test_e2e_pipeline.ts         # E2E test: boots engine, tick() once, asserts 7 checks
  test_full_trade.ts           # Swap + arb + flash loan test
  test_protection_integration.ts  # Real devnet protection tests
  create_dirty_pool.ts         # Creates dirty1/fUSDC pool for e2e
  populate_caches.ts           # Seeds Redis with synthetic anomaly scores
  revoke_mint.ts               # Revokes mint+freeze authority on clean tokens
  create_tokens.ts / create_pools.ts  # Initial devnet setup

ai/
  server.py                    # FastAPI skeleton — /health only, no AI yet
```

## Phase Completion Status

| Phase | Status | Description |
|-------|--------|-------------|
| 1 | DONE | Infrastructure (RPC, wallet, logger, Redis, config) |
| 2 | DONE | DevNet simulation (tokens, pools, dirty tokens) |
| 3 | DONE | Redis cache layer (sentiment, whale, lstm, token_score, ema) |
| 4 | DONE | Opportunity detectors (arb, liquidation, yield, router) |
| 5 | DONE | Safety filters (S1-S4 pipeline) |
| 6 | DONE | Anchor programs on devnet (AMM + flash loan) |
| 7 | DONE | Execution layer (route planner, tx builder, fee calc, sandwich) |
| 8 | PARTIAL | AI server skeleton only — no models, no endpoints |
| 9 | DONE | Protection layer (auto-pause, drawdown, slippage, trading hours) |
| 10 | CANCELLED | RWA — user decided not to do this |
| 11 | DONE | Trading engine + main.ts loop (fast path working) |
| 12 | NOT STARTED | Mainnet preparation |
| 13 | NOT STARTED | Frontend dashboard |
| 14 | NOT STARTED | Production deployment |

## What's Blocked

Phase 8 (AI models) blocks everything else:
- `decision_model.ts` needs LSTM + sentiment + whale signals → blocks slow path
- `slippage_optimizer.ts` needs `/predict/slippage` endpoint
- `volatility_predictor.ts` needs `/predict/volatility` endpoint
- Slow path trades skip execution until Phase 8 is done

Fast path works end-to-end right now without AI.

## DevNet Setup & Testing

Prerequisites before running the bot or e2e test:
```bash
# 1. Start Redis
redis-server

# 2. Revoke mint authorities on clean tokens (run once, permanent)
npx ts-node scripts/devnet/revoke_mint.ts

# 3. Create dirty pool for e2e testing (run once)
npx ts-node scripts/devnet/create_dirty_pool.ts

# 4. Populate Redis with anomaly scores (run after each Redis restart)
npx ts-node scripts/devnet/populate_caches.ts
```

Run the bot (24/7 loop):
```bash
npx ts-node src/main.ts
```

Run e2e test (single tick):
```bash
npx ts-node scripts/devnet/test_e2e_pipeline.ts
```

The e2e test creates a price gap → calls `engine.tick()` once → asserts:
- 4 pools scanned (3 clean + 1 dirty)
- 2 opportunities found (triangular arb + dirty pool)
- Dirty pool rejected by safety (S1: mint authority active)
- Clean arb executed with profit via flash loan
- Protection state healthy after

## DevNet Config Gotchas

`settings.yaml` has devnet-specific thresholds that MUST change for mainnet:

| Setting | DevNet Value | Mainnet Value | Why |
|---------|-------------|---------------|-----|
| `max_dev_wallet_pct` | 100 | 20 | We minted all tokens, wallet holds ~100% |
| `wash_trading_top2_threshold` | 1.0 | 0.95 | We own everything, top 2 holders = us + pool |
| `min_unique_holders` | 1 | 10+ | Only a few holders on devnet |

## Key Patterns

- `getConfig()` / `getStrategyConfig()` — singleton YAML loaders, never import yaml files directly
- `loadWallet()` — loads from `config/dev-wallet.json`
- fUSDC (tokenA) is the base token — always trusted, never safety-checked
- Token mints are resolved from pool config: `pool.tokenAMint`/`pool.tokenBMint` or looked up by name in devnet_tokens.json
- Flash loan atomicity: `flash_borrow` uses instruction introspection to verify `flash_repay` exists in the same transaction
- AMM formula: `output = (amountIn * 997 * reserveOut) / (reserveIn * 1000 + amountIn * 997)`

## Two Protection Folders (intentional)

- `src/protection/` — Pure business logic (no Solana imports): auto-pause counter, drawdown tracker, slippage calculator, trading hours
- `src/layer3_protection/` — Solana wrappers that import `src/protection/`: tx submission, on-chain simulation, Jito bundles, EventEmitter events

## Environment

- Project lives in WSL Ubuntu at `/home/user/projects/solana-trading-bot`
- Windows accesses via `\\wsl.localhost\Ubuntu\...`
- `npx tsc --noEmit` must run from inside WSL shell (not Windows)
- Git push needs PAT authentication
