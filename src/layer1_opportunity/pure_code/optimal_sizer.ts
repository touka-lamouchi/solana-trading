/**
 * OptimalSizer — for a given cycle, find the input amount that maximizes
 * net profit (gross profit minus expected fees).
 *
 * Constant-product profit function f(x) = swap(swap(swap(x))) - x is concave
 * with a single interior maximum (assuming the cycle is profitable at SOME
 * size). Strategy: ternary search over [minIn, maxIn].
 *
 * If the profit function is non-positive across the entire range, we return
 * { profitable: false }. This avoids ever recommending a losing trade.
 */

import type { PoolEdge } from "./token_graph";
import { simulateCycle } from "./cycle_simulator";

export interface SizingResult {
  profitable: boolean;
  /** Optimal input amount in base-token units (e.g., 500.0 for 500 fUSDC). */
  amountIn: number;
  /** Gross profit at the optimal size. */
  grossProfit: number;
  /** Net profit after subtracting estimated total fee. */
  netProfit: number;
}

export interface SizingOptions {
  /** Lower bound for amountIn (in token units, e.g. 1.0 = 1 fUSDC). */
  minIn: number;
  /** Upper bound. Caller should clamp this to user.maxTradeUsd and
   *  flash_loan_max_usd. */
  maxIn: number;
  /** Estimated per-trade fee (gas + priority + protocol) in base-token units.
   *  E.g. 0.05 = $0.05 worth. Set to 0 to ignore fees during sizing. */
  estimatedFeeBase: number;
  /** Minimum profit-multiplier over fee for the trade to be considered
   *  profitable. Default 1.5 (= 50% safety margin above fee). */
  minProfitMultiplier?: number;
  /** Iteration cap for ternary search. */
  iterations?: number;
}

export function findOptimalSize(cycle: PoolEdge[], opts: SizingOptions): SizingResult {
  const min = Math.max(0, opts.minIn);
  const max = Math.max(min, opts.maxIn);
  const fee = Math.max(0, opts.estimatedFeeBase);
  const multiplier = opts.minProfitMultiplier ?? 1.5;
  const iters = opts.iterations ?? 60;

  if (max <= min) return unprofitable();

  // First quick test: are the boundaries even non-zero output?
  const probe = simulateCycle(cycle, max);
  if (!probe) return unprofitable();

  // Ternary search on net profit.
  let lo = min;
  let hi = max;
  const profit = (x: number): number => {
    const sim = simulateCycle(cycle, x);
    if (!sim) return -Infinity;
    return sim.grossProfit - fee;
  };

  for (let i = 0; i < iters; i++) {
    if (hi - lo < 1e-6) break;
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    const p1 = profit(m1);
    const p2 = profit(m2);
    if (p1 < p2) lo = m1;
    else hi = m2;
  }
  const x = (lo + hi) / 2;
  const sim = simulateCycle(cycle, x);
  if (!sim) return unprofitable();

  const netProfit = sim.grossProfit - fee;
  const profitable = netProfit > 0 && sim.grossProfit > fee * multiplier;

  return {
    profitable,
    amountIn: x,
    grossProfit: sim.grossProfit,
    netProfit,
  };
}

function unprofitable(): SizingResult {
  return { profitable: false, amountIn: 0, grossProfit: 0, netProfit: 0 };
}
