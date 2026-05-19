/**
 * arb_graph_builder — turns a list of PoolRecord into a TokenGraph and runs
 * cycle discovery + sizing. Pure logic, no Solana imports.
 *
 * This is what ArbReactor calls every time pool reserves change. It returns
 * a ranked list of profitable cycles (by net profit), with each item carrying
 * the optimal amountIn and the simulator output, ready to hand off to the
 * executor.
 */

import { TokenGraph, type PoolEdge } from "./token_graph";
import { findCycles } from "./cycle_finder";
import { simulateCycle, type SimulatedCycle } from "./cycle_simulator";
import { findOptimalSize } from "./optimal_sizer";
import type { PoolRecord } from "./pool_registry";

export interface RankedCycle {
  cycle: PoolEdge[];
  amountIn: number;
  grossProfit: number;
  netProfit: number;
  simulation: SimulatedCycle;
}

export interface BuildAndFindOptions {
  baseMint: string;
  /** Lower / upper bounds for amountIn in base-token units. */
  minIn: number;
  maxIn: number;
  /** Estimated total network + priority + protocol fee for one cycle, in base-token units. */
  estimatedFeeBase: number;
  /** Profit must clear `estimatedFeeBase * minProfitMultiplier` to be returned. */
  minProfitMultiplier?: number;
  /** Cycle hop bounds. */
  minDepth?: number;
  maxDepth?: number;
  /** Cap on cycle enumeration. */
  maxCycles?: number;
}

/** Construct a fresh TokenGraph from the supplied pools. */
export function buildGraph(pools: PoolRecord[]): TokenGraph {
  const g = new TokenGraph();
  for (const p of pools) {
    if (p.reserveA <= 0 || p.reserveB <= 0) continue;
    g.upsertPool({
      poolKey: p.poolKey,
      mintA: p.mintA,
      mintB: p.mintB,
      reserveA: p.reserveA,
      reserveB: p.reserveB,
      feeNumerator: p.feeNumerator,
      feeDenominator: p.feeDenominator,
      decimalsA: p.decimalsA,
      decimalsB: p.decimalsB,
      ...(p.symbolA !== undefined ? { symbolA: p.symbolA } : {}),
      ...(p.symbolB !== undefined ? { symbolB: p.symbolB } : {}),
    });
  }
  return g;
}

/**
 * Discover all profitable cycles for the given base token, sized optimally,
 * sorted descending by netProfit. Returns [] when nothing clears the fee gate.
 */
export function findRankedCycles(
  pools: PoolRecord[],
  opts: BuildAndFindOptions,
): RankedCycle[] {
  const graph = buildGraph(pools);
  if (graph.edgesFrom(opts.baseMint).length === 0) return [];

  const findOpts: { minDepth: number; maxDepth: number; maxCycles?: number } = {
    minDepth: opts.minDepth ?? 2,
    maxDepth: opts.maxDepth ?? 4,
    ...(opts.maxCycles !== undefined ? { maxCycles: opts.maxCycles } : {}),
  };
  const cycles = findCycles(graph, opts.baseMint, findOpts);

  const ranked: RankedCycle[] = [];
  for (const cycle of cycles) {
    const sizingOpts: Parameters<typeof findOptimalSize>[1] = {
      minIn: opts.minIn,
      maxIn: opts.maxIn,
      estimatedFeeBase: opts.estimatedFeeBase,
      ...(opts.minProfitMultiplier !== undefined ? { minProfitMultiplier: opts.minProfitMultiplier } : {}),
    };
    const sized = findOptimalSize(cycle, sizingOpts);
    if (!sized.profitable) continue;
    const sim = simulateCycle(cycle, sized.amountIn);
    if (!sim) continue;
    ranked.push({
      cycle,
      amountIn: sized.amountIn,
      grossProfit: sized.grossProfit,
      netProfit: sized.netProfit,
      simulation: sim,
    });
  }

  ranked.sort((a, b) => b.netProfit - a.netProfit);
  return ranked;
}

/** Produce a human-readable label for a cycle, using symbols when present. */
export function cycleLabel(cycle: PoolEdge[]): string {
  const tokens = [cycle[0]!.symbolIn ?? cycle[0]!.fromMint.slice(0, 4)];
  for (const e of cycle) tokens.push(e.symbolOut ?? e.toMint.slice(0, 4));
  return tokens.join("→");
}
