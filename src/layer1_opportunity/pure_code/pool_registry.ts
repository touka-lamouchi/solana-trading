/**
 * PoolRegistry — in-memory cache of all known AMM pools, keyed by their PDA
 * address. Pure logic, no RPC. Populated by an external loader (file in
 * devnet, getProgramAccounts on mainnet) and updated by accountSubscribe
 * callbacks.
 *
 * Mirrors what TokenGraph needs but keeps richer metadata (vault addresses,
 * mint addresses, last-update timestamp, staleness).
 */

export interface PoolRecord {
  /** Pool PDA address — stable identifier. */
  poolKey: string;
  /** Human label e.g. "fUSDC/fSOL". Optional. */
  name?: string;
  /** Token A SPL mint address. */
  mintA: string;
  /** Token B SPL mint address. */
  mintB: string;
  /** Vault SPL token accounts owned by the pool, holding the actual reserves. */
  vaultA: string;
  vaultB: string;
  /** Live reserves in human (decimals-applied) units. */
  reserveA: number;
  reserveB: number;
  /** AMM fee, e.g. 997/1000 for 0.3%. */
  feeNumerator: number;
  feeDenominator: number;
  /** Token decimals. */
  decimalsA: number;
  decimalsB: number;
  /** Optional human symbols (logging only). */
  symbolA?: string;
  symbolB?: string;
  /** ms since epoch of last reserve update. */
  updatedAt: number;
}

export class PoolRegistry {
  private pools: Map<string, PoolRecord> = new Map();

  size(): number {
    return this.pools.size;
  }

  has(poolKey: string): boolean {
    return this.pools.has(poolKey);
  }

  get(poolKey: string): PoolRecord | undefined {
    return this.pools.get(poolKey);
  }

  list(): PoolRecord[] {
    return Array.from(this.pools.values());
  }

  upsert(rec: PoolRecord): void {
    this.pools.set(rec.poolKey, { ...rec });
  }

  /** Update only the reserves + timestamp. No-op if pool unknown. */
  updateReserves(poolKey: string, reserveA: number, reserveB: number, ts = Date.now()): void {
    const cur = this.pools.get(poolKey);
    if (!cur) return;
    this.pools.set(poolKey, { ...cur, reserveA, reserveB, updatedAt: ts });
  }

  remove(poolKey: string): void {
    this.pools.delete(poolKey);
  }

  /** Pools whose reserves haven't been refreshed within `maxAgeMs`. */
  stale(maxAgeMs: number, now = Date.now()): PoolRecord[] {
    return this.list().filter(p => now - p.updatedAt > maxAgeMs);
  }
}
