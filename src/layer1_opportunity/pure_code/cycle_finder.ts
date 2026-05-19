/**
 * CycleFinder — DFS enumeration of all closed cycles from a base mint back to
 * the base mint, bounded by max depth. Pure logic.
 *
 * A cycle is a list of edges [e1, e2, …, eN] such that:
 *   - e1.fromMint == baseMint
 *   - eN.toMint == baseMint
 *   - e[i].toMint == e[i+1].fromMint
 *   - no two edges share the same pool (no double-using a pool in one cycle)
 *
 * Self-loops, length-1 cycles, and revisits are excluded.
 *
 * Performance: with ~10 pools and depth 4 the enumeration is trivial. With
 * thousands of pools (mainnet), use Bellman-Ford on -log(price) edges instead;
 * we keep DFS here because devnet has a small fixed pool set and DFS gives us
 * exact paths (Bellman-Ford only gives existence of negative cycle).
 */

import type { PoolEdge, TokenGraph } from "./token_graph";

export interface FindOptions {
  /** Inclusive lower bound on hop count (default 2). 1 is impossible. */
  minDepth?: number;
  /** Inclusive upper bound on hop count (default 4). */
  maxDepth?: number;
  /** Hard cap on enumerated cycles to prevent runaway. */
  maxCycles?: number;
}

/**
 * Enumerates all simple cycles starting and ending at baseMint.
 *
 * Both traversal directions of the same loop are kept (e.g. fUSDC→fSOL→fRAY→fUSDC
 * AND fUSDC→fRAY→fSOL→fUSDC). They have opposite swap directions on each pool,
 * which means different reserveIn/reserveOut and therefore different profit math.
 * The simulator + sizer downstream will pick the one that's actually profitable.
 */
export function findCycles(
  graph: TokenGraph,
  baseMint: string,
  opts: FindOptions = {},
): PoolEdge[][] {
  const minDepth = Math.max(2, opts.minDepth ?? 2);
  const maxDepth = Math.max(minDepth, opts.maxDepth ?? 4);
  const maxCycles = opts.maxCycles ?? 10_000;

  const out: PoolEdge[][] = [];
  const path: PoolEdge[] = [];
  const usedPools = new Set<string>();

  const dfs = (current: string): void => {
    if (out.length >= maxCycles) return;

    for (const edge of graph.edgesFrom(current)) {
      if (usedPools.has(edge.poolKey)) continue;
      if (path.length + 1 > maxDepth) continue;

      path.push(edge);
      usedPools.add(edge.poolKey);

      const reachedBase = edge.toMint === baseMint;
      if (reachedBase && path.length >= minDepth) {
        out.push(path.slice());
        if (out.length >= maxCycles) {
          usedPools.delete(edge.poolKey);
          path.pop();
          return;
        }
      }

      if (path.length < maxDepth && edge.toMint !== baseMint) {
        dfs(edge.toMint);
      }

      usedPools.delete(edge.poolKey);
      path.pop();
    }
  };

  dfs(baseMint);
  return out;
}
