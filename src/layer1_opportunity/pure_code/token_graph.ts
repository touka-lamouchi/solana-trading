/**
 * TokenGraph — adjacency map keyed by token mint, edges = pools.
 *
 * Pure logic. No Solana imports. Used by CycleFinder to enumerate cycles
 * starting and ending at a base token.
 *
 * A pool is bidirectional: from pool {tokenA, tokenB} we add two edges
 * (tokenA → tokenB) and (tokenB → tokenA). Each edge knows which side of the
 * source pool corresponds to "in" vs "out" so the simulator can pick the
 * correct reserves.
 */

export interface PoolEdge {
  /** Stable identifier of the underlying pool (PDA address). Used to dedupe. */
  poolKey: string;
  /** Mint we are spending on this hop. */
  fromMint: string;
  /** Mint we receive on this hop. */
  toMint: string;
  /** Reserve of the "from" side at the time the graph was built/updated. */
  reserveIn: number;
  /** Reserve of the "to" side at the time the graph was built/updated. */
  reserveOut: number;
  /** Fee numerator/denominator of this pool (e.g. 997/1000 = 0.3%). */
  feeNumerator: number;
  feeDenominator: number;
  /** Decimals of the input/output mints, for display + sizing math. */
  decimalsIn: number;
  decimalsOut: number;
  /** Optional human-friendly token symbols, for logging only. */
  symbolIn?: string;
  symbolOut?: string;
}

export class TokenGraph {
  /** mint → list of outgoing edges (one per pool that includes this mint). */
  private adjacency: Map<string, PoolEdge[]> = new Map();
  /** poolKey → both edges of that pool, so we can update or remove together. */
  private poolEdges: Map<string, [PoolEdge, PoolEdge]> = new Map();

  size(): number {
    return this.poolEdges.size;
  }

  mints(): string[] {
    return Array.from(this.adjacency.keys());
  }

  edgesFrom(mint: string): PoolEdge[] {
    return this.adjacency.get(mint) ?? [];
  }

  /** Insert a pool. Replaces any existing entry for the same poolKey. */
  upsertPool(pool: {
    poolKey: string;
    mintA: string;
    mintB: string;
    reserveA: number;
    reserveB: number;
    feeNumerator: number;
    feeDenominator: number;
    decimalsA: number;
    decimalsB: number;
    symbolA?: string;
    symbolB?: string;
  }): void {
    if (this.poolEdges.has(pool.poolKey)) this.removePool(pool.poolKey);

    const edgeAB: PoolEdge = {
      poolKey: pool.poolKey,
      fromMint: pool.mintA,
      toMint: pool.mintB,
      reserveIn: pool.reserveA,
      reserveOut: pool.reserveB,
      feeNumerator: pool.feeNumerator,
      feeDenominator: pool.feeDenominator,
      decimalsIn: pool.decimalsA,
      decimalsOut: pool.decimalsB,
      ...(pool.symbolA !== undefined ? { symbolIn: pool.symbolA } : {}),
      ...(pool.symbolB !== undefined ? { symbolOut: pool.symbolB } : {}),
    };
    const edgeBA: PoolEdge = {
      poolKey: pool.poolKey,
      fromMint: pool.mintB,
      toMint: pool.mintA,
      reserveIn: pool.reserveB,
      reserveOut: pool.reserveA,
      feeNumerator: pool.feeNumerator,
      feeDenominator: pool.feeDenominator,
      decimalsIn: pool.decimalsB,
      decimalsOut: pool.decimalsA,
      ...(pool.symbolB !== undefined ? { symbolIn: pool.symbolB } : {}),
      ...(pool.symbolA !== undefined ? { symbolOut: pool.symbolA } : {}),
    };

    this.appendEdge(pool.mintA, edgeAB);
    this.appendEdge(pool.mintB, edgeBA);
    this.poolEdges.set(pool.poolKey, [edgeAB, edgeBA]);
  }

  removePool(poolKey: string): void {
    const pair = this.poolEdges.get(poolKey);
    if (!pair) return;
    this.poolEdges.delete(poolKey);
    for (const edge of pair) {
      const list = this.adjacency.get(edge.fromMint);
      if (!list) continue;
      const next = list.filter(e => e.poolKey !== poolKey || e.toMint !== edge.toMint);
      if (next.length === 0) this.adjacency.delete(edge.fromMint);
      else this.adjacency.set(edge.fromMint, next);
    }
  }

  private appendEdge(mint: string, edge: PoolEdge): void {
    const list = this.adjacency.get(mint);
    if (list) list.push(edge);
    else this.adjacency.set(mint, [edge]);
  }
}
