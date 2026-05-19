/**
 * CycleSimulator — given an ordered list of pool edges forming a closed loop
 * back to the base mint, walk the constant-product math to compute the gross
 * output amount for a given input. Pure function, no RPC.
 *
 * Constant-product with fee:
 *   amountInWithFee = amountIn * feeNum
 *   amountOut = (amountInWithFee * reserveOut) / (reserveIn * feeDen + amountInWithFee)
 */

import type { PoolEdge } from "./token_graph";

export interface SimulatedCycle {
  /** Ordered hops, each step shows what was swapped on that pool. */
  steps: Array<{
    poolKey: string;
    fromMint: string;
    toMint: string;
    amountIn: number;
    amountOut: number;
  }>;
  amountIn: number;
  amountOut: number;
  /** amountOut - amountIn, in the base token's units. */
  grossProfit: number;
  /** (amountOut/amountIn - 1) * 100 */
  profitPercent: number;
}

/** Single-hop constant-product swap. Pure function. */
export function swapAmount(amountIn: number, edge: PoolEdge): number {
  if (amountIn <= 0) return 0;
  if (edge.reserveIn <= 0 || edge.reserveOut <= 0) return 0;
  const amountInWithFee = amountIn * edge.feeNumerator;
  const numerator = amountInWithFee * edge.reserveOut;
  const denominator = edge.reserveIn * edge.feeDenominator + amountInWithFee;
  if (denominator <= 0) return 0;
  return numerator / denominator;
}

/**
 * Walk a cycle. Returns null if any hop produces zero output (drained pool,
 * mismatched edge, etc.). Cycles MUST start and end at the same mint;
 * caller is responsible for building correctly-ordered cycles.
 */
export function simulateCycle(cycle: PoolEdge[], amountIn: number): SimulatedCycle | null {
  if (cycle.length < 2) return null;
  if (amountIn <= 0) return null;

  // Sanity: cycle must close — last edge's toMint == first edge's fromMint.
  if (cycle[0]!.fromMint !== cycle[cycle.length - 1]!.toMint) return null;
  // Sanity: hops chain — edge[i].toMint == edge[i+1].fromMint.
  for (let i = 0; i < cycle.length - 1; i++) {
    if (cycle[i]!.toMint !== cycle[i + 1]!.fromMint) return null;
  }

  const steps: SimulatedCycle["steps"] = [];
  let current = amountIn;
  for (const edge of cycle) {
    const out = swapAmount(current, edge);
    if (out <= 0) return null;
    steps.push({
      poolKey: edge.poolKey,
      fromMint: edge.fromMint,
      toMint: edge.toMint,
      amountIn: current,
      amountOut: out,
    });
    current = out;
  }

  const grossProfit = current - amountIn;
  return {
    steps,
    amountIn,
    amountOut: current,
    grossProfit,
    profitPercent: (grossProfit / amountIn) * 100,
  };
}
