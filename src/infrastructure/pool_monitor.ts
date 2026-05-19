import { Connection, PublicKey, AccountInfo } from "@solana/web3.js";
import { EventEmitter } from "events";
import { PoolState } from "../layer1_opportunity/pure_code/arbitrage_detector";
import type { PoolRecord } from "../layer1_opportunity/pure_code/pool_registry";
import { getConfig } from "../utils/config";
import { logger } from "../utils/logger";

/**
 * PoolMonitor — event-driven pool state tracker.
 *
 * Subscribes to every vault token account (tokenAVault + tokenBVault for
 * each pool) via connection.onAccountChange.  When Solana confirms a swap
 * the vault balances change and the OS-level WebSocket fires within one
 * slot (~400 ms).  PoolMonitor decodes the raw SPL token account balance
 * (bytes 64-71, little-endian u64) and emits a "change" event so reactors
 * can run arb / liquidation math immediately — without an RPC call.
 *
 * SPL token account layout (165 bytes):
 *   0-31   mint        (32 bytes)
 *   32-63  owner       (32 bytes)
 *   64-71  amount      (u64, little-endian)   ← we read this
 *   72     delegate_option (1 byte)
 *   ...
 *
 * Decimals are looked up from the tokens config so uiAmount = raw / 10^decimals.
 *
 * Events:
 *   "change" (poolKey: string, state: PoolState)
 *   "initialized" ()
 */
export class PoolMonitor extends EventEmitter {
  private connection: Connection;
  private pools: Record<string, any>;
  private tokens: Record<string, any>;      // devnet_tokens.json
  private states = new Map<string, PoolState>();
  private subscriptions: number[] = [];
  private running = false;

  constructor(opts: {
    connection: Connection;
    pools: Record<string, any>;
    tokens: Record<string, any>;
  }) {
    super();
    this.connection = opts.connection;
    this.pools = opts.pools;
    this.tokens = opts.tokens;
  }

  // ── Start ─────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // 1. Load initial states via RPC (one-time, needed to seed in-memory map).
    await this.loadInitialStates();

    // 2. Subscribe to every vault account.
    for (const [key, pool] of Object.entries(this.pools)) {
      if (!pool.tokenAVault || !pool.tokenBVault) continue;
      this.subscribeVault(key, pool.tokenAVault, "A");
      this.subscribeVault(key, pool.tokenBVault, "B");
    }

    logger.info(
      { pools: Object.keys(this.pools), subscriptions: this.subscriptions.length },
      "PoolMonitor started — subscribed to vault accounts",
    );

    this.emit("initialized");
  }

  // ── Stop ──────────────────────────────────────────────

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    for (const subId of this.subscriptions) {
      try {
        await this.connection.removeAccountChangeListener(subId);
      } catch { /* ignore */ }
    }
    this.subscriptions = [];
    logger.info("PoolMonitor stopped");
  }

  // ── State accessors ───────────────────────────────────

  getState(key: string): PoolState | undefined {
    return this.states.get(key);
  }

  getAllStates(): Map<string, PoolState> {
    return new Map(this.states);
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Snapshot every tracked pool as a PoolRecord (mint-aware, decimals-aware,
   * fee-aware). Used by the graph-based arbitrage detector. Returns whatever
   * states are currently in memory — pools whose initial load failed are
   * skipped.
   */
  getRecords(): PoolRecord[] {
    const cfg = getConfig();
    const feeNumerator = cfg.amm?.fee_numerator ?? 997;
    const feeDenominator = cfg.amm?.fee_denominator ?? 1000;

    const out: PoolRecord[] = [];
    for (const [key, state] of this.states.entries()) {
      const pool = this.pools[key];
      if (!pool) continue;
      const mintA = this.resolveMint(pool, "A");
      const mintB = this.resolveMint(pool, "B");
      if (!mintA || !mintB) continue;
      const decimalsA = this.resolveDecimals(pool.tokenA);
      const decimalsB = this.resolveDecimals(pool.tokenB);
      out.push({
        poolKey: key,
        name: state.name ?? key,
        mintA, mintB,
        vaultA: pool.tokenAVault,
        vaultB: pool.tokenBVault,
        reserveA: state.reserveA,
        reserveB: state.reserveB,
        feeNumerator, feeDenominator,
        decimalsA, decimalsB,
        symbolA: pool.tokenA,
        symbolB: pool.tokenB,
        updatedAt: Date.now(),
      });
    }
    return out;
  }

  private resolveMint(pool: any, side: "A" | "B"): string | null {
    // Pools may carry explicit mint fields (used by the dirty pool config).
    if (side === "A" && pool.tokenAMint) return pool.tokenAMint;
    if (side === "B" && pool.tokenBMint) return pool.tokenBMint;
    const symbol: string = side === "A" ? pool.tokenA : pool.tokenB;
    for (const entry of Object.values(this.tokens) as any[]) {
      if (entry?.name === symbol && entry?.mint) return entry.mint;
    }
    return null;
  }

  // ── Private helpers ───────────────────────────────────

  private async loadInitialStates(): Promise<void> {
    for (const [key, pool] of Object.entries(this.pools)) {
      if (!pool.tokenAVault || !pool.tokenBVault) continue;
      try {
        const [rawA, rawB] = await Promise.all([
          this.connection.getTokenAccountBalance(new PublicKey(pool.tokenAVault)),
          this.connection.getTokenAccountBalance(new PublicKey(pool.tokenBVault)),
        ]);
        const reserveA = parseFloat(rawA.value.uiAmountString!);
        const reserveB = parseFloat(rawB.value.uiAmountString!);
        this.states.set(key, {
          name: pool.name ?? key,
          address: pool.address,
          tokenAVault: pool.tokenAVault,
          tokenBVault: pool.tokenBVault,
          reserveA,
          reserveB,
          price: reserveB > 0 ? reserveA / reserveB : 0,
        });
        logger.info(
          { pool: key, reserveA: reserveA.toFixed(2), reserveB: reserveB.toFixed(2) },
          "PoolMonitor: initial state loaded",
        );
      } catch (e: any) {
        logger.warn({ pool: key, error: e.message }, "PoolMonitor: initial state load failed");
      }
    }
  }

  private subscribeVault(poolKey: string, vaultAddress: string, side: "A" | "B"): void {
    try {
      const subId = this.connection.onAccountChange(
        new PublicKey(vaultAddress),
        (accountInfo: AccountInfo<Buffer>) => {
          this.onVaultChange(poolKey, side, accountInfo);
        },
        "confirmed",
      );
      this.subscriptions.push(subId);
    } catch (e: any) {
      logger.warn(
        { pool: poolKey, vault: vaultAddress, side, error: e.message },
        "PoolMonitor: subscription failed",
      );
    }
  }

  private onVaultChange(poolKey: string, side: "A" | "B", accountInfo: AccountInfo<Buffer>): void {
    const state = this.states.get(poolKey);
    if (!state) return;

    // SPL token account: amount is a u64 at bytes 64-71 (little-endian).
    if (accountInfo.data.length < 72) return;

    const rawAmount = accountInfo.data.readBigUInt64LE(64);
    const pool = this.pools[poolKey];
    if (!pool) return;

    // Resolve decimals from tokens config by matching token name.
    const tokenName: string = side === "A" ? pool.tokenA : pool.tokenB;
    const decimals = this.resolveDecimals(tokenName);
    const uiAmount = Number(rawAmount) / Math.pow(10, decimals);

    if (side === "A") {
      state.reserveA = uiAmount;
    } else {
      state.reserveB = uiAmount;
    }
    state.price = state.reserveB > 0 ? state.reserveA / state.reserveB : 0;

    logger.debug(
      { pool: poolKey, side, uiAmount: uiAmount.toFixed(4) },
      "PoolMonitor: vault changed",
    );

    this.emit("change", poolKey, { ...state });
  }

  private resolveDecimals(tokenName: string): number {
    for (const entry of Object.values(this.tokens) as any[]) {
      if (entry.name === tokenName) return entry.decimals ?? 6;
    }
    return 6; // safe fallback (fUSDC / fRAY are 6)
  }
}
