# DevNet scripts

Operational scripts for bringing up devnet, seeding it, and producing real
on-chain activity for the live bot.

> **Tests** live in `/tests` (`unit/`, `integration/`). This folder is for
> *acting* on devnet, not verifying code.

---

## Layout

| Folder      | Purpose                                                   |
|-------------|-----------------------------------------------------------|
| `setup/`    | One-time devnet bring-up. Run files in numeric order.     |
| `trigger/`  | Create real opportunities for the running bot.            |
| `archive/`  | Stale or superseded scripts. Kept for reference.          |

---

## I want to test X → run Y

| What I want to do                                  | Command                                                              |
|----------------------------------------------------|----------------------------------------------------------------------|
| Bring up a fresh devnet from scratch               | `setup/01_…` through `setup/07_…` in order                           |
| Re-populate Redis after a restart                  | `npx ts-node scripts/devnet/setup/populate_caches.ts`                |
| Make the bot detect a triangular arb               | `npx ts-node scripts/devnet/trigger/create_arb.ts`                   |
| Make the bot detect a liquidation                  | `npx ts-node scripts/devnet/trigger/create_loan.ts --collateralToken=fSOL --collateralAmount=10 --debtToken=fUSDC --debtAmount=1700 --threshold=1.20` |
| List / clear the loan registry                     | `… create_loan.ts --list` / `--clear` / `--delete=<id>`              |
| Send test tokens to a Phantom wallet               | `npx ts-node scripts/devnet/trigger/send_token_to.ts ALL <pubkey>`   |
| Run the full tick pipeline end-to-end              | `npx ts-node tests/integration/test_e2e_pipeline.ts`                 |
| Run a single integration / unit test               | `npx ts-node tests/{integration,unit}/<file>.ts`                     |

---

## Setup order (one-time per fresh devnet)

```bash
npx ts-node scripts/devnet/setup/01_create_tokens.ts        # mint fUSDC/fSOL/fRAY
npx ts-node scripts/devnet/setup/02_revoke_mint.ts          # lock supply
npx ts-node scripts/devnet/setup/03_create_pools.ts         # 3 AMM pools
npx ts-node scripts/devnet/setup/04_create_dirty_tokens.ts  # for safety filter tests
npx ts-node scripts/devnet/setup/05_create_dirty_pool.ts
npx ts-node scripts/devnet/setup/06_setup_flash_vault.ts    # flash loan reserve
npx ts-node scripts/devnet/setup/07_deploy_vault.ts         # bot's reference vault
npx ts-node scripts/devnet/setup/populate_caches.ts         # Redis warm-up
```

`populate_caches.ts` must be re-run after every Redis restart.

---

## Trigger scripts

These produce **real on-chain activity** the live bot will detect on its next tick.

- `trigger/create_arb.ts` — pushes a pool out of equilibrium. Triangular arb
  detector fires within ~10s. Optional args: `<pool> <amount>`.
- `trigger/create_loan.ts` — registers a loan position in the Redis registry.
  Liquidation hunter reads it, computes health from live pool reserves.
- `trigger/send_token_to.ts` — fund any wallet with `fUSDC | fSOL | fRAY | ALL`.

---

## Archive

Kept for reference, not part of any workflow:

- `mint_fusdc_to.ts` — superseded by `trigger/send_token_to.ts`
- `simulate_arb.ts`, `simulator.ts` — offline math sims, replaced by `create_arb.ts`
- `test_transaction.ts` — minimal SOL-transfer probe
- `check_mints.ts` — one-off mint authority check
