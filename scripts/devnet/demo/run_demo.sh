#!/usr/bin/env bash
# Eyes-on demo: run each trigger sequentially with banners + pauses so a viewer
# can watch the frontend (LiveCockpit / Analytics) react in real time. No
# assertions and no automatic config restore — keep an eye on the frontend.
#
# Prereqs (all running): Redis, AI server, API server, frontend, user Started.
#
# Usage:
#   ./scripts/devnet/demo/run_demo.sh                 # full sequence
#   PAUSE=10 SETTLE=15 ./scripts/devnet/demo/run_demo.sh
#   USER_ID=<phantom-pubkey> ./scripts/devnet/demo/run_demo.sh
#   SKIP="drawdown,hours" ./scripts/devnet/demo/run_demo.sh
#
# Tip: run from the repo root (cd ~/projects/solana-trading-bot).

set -u

API="${API:-http://localhost:3001}"
PAUSE="${PAUSE:-12}"     # seconds to wait BEFORE each trigger (so you can switch tab)
SETTLE="${SETTLE:-18}"   # seconds to wait AFTER each trigger (let bot react)
SKIP="${SKIP:-}"

# ── helpers ──────────────────────────────────────────────────────────────────
banner() {
  local title="$1" sub="$2"
  printf '\n%s\n  %s\n  %s\n%s\n' \
    "════════════════════════════════════════════════════════════════════════" \
    "$title" "$sub" \
    "════════════════════════════════════════════════════════════════════════"
}

countdown() {
  local n="$1" label="$2"
  for ((i=n; i>0; i--)); do
    printf "\r  %s — %ds " "$label" "$i"
    sleep 1
  done
  printf "\r  %s — done.        \n" "$label"
}

skip_match() {
  local name="$1"
  [[ ",$SKIP," == *",$name,"* ]]
}

resolve_user_id() {
  if [[ -n "${USER_ID:-}" ]]; then echo "$USER_ID"; return; fi
  local raw
  raw="$(curl -s "$API/users")"
  # extract first activeUsers array entry without jq dependency
  local id
  id="$(printf '%s' "$raw" | grep -oE '"[1-9A-HJ-NP-Za-km-z]{32,44}"' | head -1 | tr -d '"')"
  if [[ -z "$id" ]]; then
    echo "no active users found at $API/users — pass USER_ID=<pubkey> or click Start in the frontend" >&2
    exit 2
  fi
  echo "$id"
}

post_config() {
  curl -s -X POST -H "Content-Type: application/json" \
    -d "$1" "$API/users/$UID_/config" >/dev/null
}

get_pool1_price() {
  curl -s "$API/market" \
    | grep -oE '"reserveA":[0-9.]+|"reserveB":[0-9.]+|"key":"pool1"' \
    | head -3 \
    | awk -F: 'BEGIN{a=0;b=0} /reserveA/{a=$2} /reserveB/{b=$2} END{ if(b>0) printf "%.0f", a/b; else print "4500" }'
}

# ── prelude ──────────────────────────────────────────────────────────────────
UID_="$(resolve_user_id)"
banner "DEMO (eyes-on)" "user=$UID_   pause=${PAUSE}s   settle=${SETTLE}s"

# Sanity check
if ! curl -sf "$API/users/$UID_/status" >/dev/null; then
  echo "API not reachable or user not started" >&2
  exit 2
fi

run_step() {
  local name="$1" watch="$2" cmd="$3"
  if skip_match "$name"; then
    banner "SCENARIO: $name" "SKIPPED (in SKIP list)"
    return
  fi
  banner "SCENARIO: $name" "WATCH FRONTEND: $watch"
  countdown "$PAUSE" "switch tab to frontend"
  echo "  → $cmd"
  eval "$cmd" || echo "  (trigger exited non-zero — keep watching)"
  countdown "$SETTLE" "settle"
}

# ── reset to a known-good config ─────────────────────────────────────────────
banner "RESET" "switch user to active mode + sane defaults"
post_config '{"mode":"active","dailyLimitUsd":500,"maxTradeUsd":1000,"flashLoans":true,"liquidations":true,"yieldGaps":false,"chartPatterns":false,"socialBuzz":false,"copyWhales":false,"tradingHoursStart":"00:00","tradingHoursEnd":"23:59"}'
echo "  config reset → mode=active, daily=500, hours=00:00–23:59"

# ── scenarios ────────────────────────────────────────────────────────────────

run_step "arb_win" \
  "frontend → green triangular-arb trade rows (flash loan + sweep into vault)" \
  "npx ts-node scripts/devnet/trigger/create_arb.ts pool1 0.3 --reverse"

run_step "arb_win_fusdc" \
  "same as arb_win but pushes the pool with fUSDC (needs fUSDC in bot wallet)" \
  "npx ts-node scripts/devnet/trigger/create_arb.ts pool1 500"

run_step "arb_cascade" \
  "multiple shrinking arb rows back-to-back (each rebalances the pool a bit)" \
  "npx ts-node scripts/devnet/trigger/create_arb.ts pool1 0.6 --reverse"

run_step "arb_cascade_fusdc" \
  "cascade variant pushed with fUSDC (skip if bot wallet lacks fUSDC)" \
  "npx ts-node scripts/devnet/trigger/create_arb.ts pool1 1500"

run_step "fee_guard_skip" \
  "tiny gap — bot may skip if expected profit < gas (fee guard); few or no rows" \
  "npx ts-node scripts/devnet/trigger/create_arb.ts pool1 0.01 --reverse"

run_step "fee_guard_skip_fusdc" \
  "tiny-gap variant pushed with fUSDC" \
  "npx ts-node scripts/devnet/trigger/create_arb.ts pool1 50"

# ── drawdown trip ────────────────────────────────────────────────────────────
if ! skip_match "drawdown"; then
  banner "SCENARIO: drawdown_stop" "frontend protection panel flips to PAUSED"
  countdown "$PAUSE" "switch tab to frontend"
  echo "  → set dailyLimitUsd=0.01 then push pool1"
  post_config '{"dailyLimitUsd":0.01}'
  npx ts-node scripts/devnet/trigger/create_arb.ts pool1 0.3 --reverse || true
  countdown "$SETTLE" "settle"
  echo "  → restoring dailyLimitUsd=500"
  post_config '{"dailyLimitUsd":500}'
fi

# ── trading hours block ──────────────────────────────────────────────────────
if ! skip_match "hours"; then
  banner "SCENARIO: trading_hours_block" "no executions during the closed window"
  countdown "$PAUSE" "switch tab to frontend"
  echo "  → set window to a 1-min slot at 00:00–00:01"
  post_config '{"tradingHoursStart":"00:00","tradingHoursEnd":"00:01"}'
  npx ts-node scripts/devnet/trigger/create_arb.ts pool1 0.3 --reverse || true
  countdown "$SETTLE" "settle"
  echo "  → restoring full-day window"
  post_config '{"tradingHoursStart":"00:00","tradingHoursEnd":"23:59"}'
fi

# ── liquidation: detection but ignored ───────────────────────────────────────
if ! skip_match "liq_disabled"; then
  banner "SCENARIO: liquidations_disabled" "frontend shows no liq trade row"
  countdown "$PAUSE" "switch tab to frontend"
  echo "  → liquidations:false, then register an unhealthy position"
  post_config '{"liquidations":false}'
  PRICE="$(get_pool1_price)"
  DEBT="$(awk -v p="$PRICE" 'BEGIN{ printf "%.0f", p/1.10 }')"
  echo "  → fSOL price≈$PRICE, debt=$DEBT"
  npx ts-node scripts/devnet/trigger/register_position.ts \
    --collateralToken=fSOL --collateralAmount=1 \
    --debtToken=fUSDC --debtAmount="$DEBT" \
    --threshold=1.20 || true
  countdown "$SETTLE" "settle"
  echo "  → restoring liquidations:true"
  post_config '{"liquidations":true}'
fi

# ── liquidation: real execution ──────────────────────────────────────────────
if ! skip_match "liq_win"; then
  banner "SCENARIO: liquidation_win" "frontend → liquidation row with positive profit"
  countdown "$PAUSE" "switch tab to frontend"
  PRICE="$(get_pool1_price)"
  DEBT="$(awk -v p="$PRICE" 'BEGIN{ printf "%.0f", p/1.10 }')"
  echo "  → fSOL price≈$PRICE, debt=$DEBT (health < 1.20 → liquidatable)"
  npx ts-node scripts/devnet/trigger/register_position.ts \
    --collateralToken=fSOL --collateralAmount=1 \
    --debtToken=fUSDC --debtAmount="$DEBT" \
    --threshold=1.20 || true
  countdown "$SETTLE" "settle"
fi

# ── final ────────────────────────────────────────────────────────────────────
banner "DONE" "review the frontend trade log + Analytics tab"
echo "  config left in default state. Status snapshot:"
curl -s "$API/users/$UID_/status" \
  | grep -oE '"(running|balance|autoPaused|drawdownExceeded)":[^,}]+' \
  | sed 's/^/    /'
echo
