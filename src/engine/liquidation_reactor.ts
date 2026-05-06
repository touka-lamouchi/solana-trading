import { Connection, PublicKey, AccountInfo } from "@solana/web3.js";
import { PoolMonitor } from "../infrastructure/pool_monitor";
import { LiquidationHunter } from "../layer1_opportunity/pure_code/liquidation_hunter";
import { ArbOpportunity, PoolState } from "../layer1_opportunity/pure_code/arbitrage_detector";
import { LendingClient, DecodedPosition } from "../layer2_execution/lending_client";
import { getConfig } from "../utils/config";
import { logger } from "../utils/logger";
import type { LiqOpportunityEvent } from "../graph/events";
import { DiscoveredOpportunity } from "./arb_reactor";

/**
 * LiquidationReactor — event-driven liquidation detector.
 *
 * Phase 6c: Uses accountSubscribe on on-chain position PDAs for immediate
 * notification when a position's collateral or debt changes. Falls back to
 * the Redis poll path when lendingClient is not available.
 *
 * On start:
 *   1. loadFromChain() — discover all active positions + subscribe each PDA
 *   2. setInterval(30s) — rescan for newly registered positions
 *   3. poolMonitor "change" — re-price all in-memory positions, scan for liq
 *
 * On accountChange callback for a subscribed PDA:
 *   - Re-decode the LoanPosition
 *   - If is_liquidated: remove subscription (someone else executed it)
 *   - Else: update in-memory state + scan immediately
 */
export class LiquidationReactor {
  private poolMonitor: PoolMonitor;
  private connection: Connection;
  private liquidationHunter: LiquidationHunter;
  private lendingClient: LendingClient | null;
  private tokens: any;
  private pools: any;
  private baseMint: string;
  private enqueue: (event: LiqOpportunityEvent) => void;
  private getUserConfig: () => any;
  private userId: string;

  private lastCheck = 0;
  private readonly COOLDOWN_MS = 1_000;

  // Phase 6c: map of PDA string → subscription id
  private positionSubs = new Map<string, number>();
  // Phase 6c: interval for scanning newly registered positions
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private readonly RESCAN_MS = 30_000;

  // Fallback: Redis reload timer (used when lendingClient is absent)
  private redisReloadTimer: ReturnType<typeof setInterval> | null = null;

  // tokenNameByMint — built once from devnet_tokens.json for chain decode
  private tokenNameByMint: Record<string, string> = {};

  constructor(opts: {
    connection: Connection;
    poolMonitor: PoolMonitor;
    liquidationHunter: LiquidationHunter;
    lendingClient?: LendingClient | null;
    tokens: any;
    pools: any;
    baseMint: string;
    userId: string;
    enqueue: (event: LiqOpportunityEvent) => void;
    getUserConfig: () => any;
  }) {
    this.connection = opts.connection;
    this.poolMonitor = opts.poolMonitor;
    this.liquidationHunter = opts.liquidationHunter;
    this.lendingClient = opts.lendingClient ?? null;
    this.tokens = opts.tokens;
    this.pools = opts.pools;
    this.baseMint = opts.baseMint;
    this.userId = opts.userId;
    this.enqueue = opts.enqueue;
    this.getUserConfig = opts.getUserConfig;

    for (const entry of Object.values(this.tokens) as any[]) {
      if (entry.mint) this.tokenNameByMint[entry.mint] = entry.name;
    }
  }

  start(): void {
    if (this.lendingClient) {
      this.startOnChainMode();
    } else {
      this.startRedisMode();
    }

    this.poolMonitor.on("change", () => {
      this.check().catch((e: any) =>
        logger.warn({ error: e.message }, "LiquidationReactor: check error"),
      );
    });

    logger.info(
      { mode: this.lendingClient ? "accountSubscribe" : "redis-poll" },
      "LiquidationReactor started",
    );
  }

  stop(): void {
    // Unsubscribe all position accounts
    for (const [pda, subId] of this.positionSubs) {
      this.connection.removeAccountChangeListener(subId).catch(() => {});
    }
    this.positionSubs.clear();

    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    if (this.redisReloadTimer) {
      clearInterval(this.redisReloadTimer);
      this.redisReloadTimer = null;
    }
  }

  // ── On-chain mode (Phase 6c) ─────────────────────────────────────────────

  private startOnChainMode(): void {
    // Initial load + subscribe
    this.loadAndSubscribeAll().catch((e: any) =>
      logger.warn({ error: e.message }, "LiquidationReactor: initial chain load failed"),
    );

    // Periodic rescan to pick up newly registered positions
    this.scanTimer = setInterval(() => {
      this.loadAndSubscribeAll().catch(() => {});
    }, this.RESCAN_MS);
  }

  private async loadAndSubscribeAll(): Promise<void> {
    if (!this.lendingClient) return;
    await this.liquidationHunter.loadFromChain(this.tokenNameByMint);
    const positions = this.liquidationHunter.getPositions();
    for (const pos of positions) {
      if (!pos.positionPda) continue;
      if (this.positionSubs.has(pos.positionPda)) continue; // already subscribed
      const pda = new PublicKey(pos.positionPda);
      this.subscribePosition(pda);
    }
    logger.debug({ subscribed: this.positionSubs.size }, "LiquidationReactor: positions subscribed");
  }

  private subscribePosition(pda: PublicKey): void {
    if (!this.lendingClient) return;
    const pdaStr = pda.toBase58();
    const subId = this.connection.onAccountChange(
      pda,
      (info: AccountInfo<Buffer>) => {
        this.onPositionChange(pda, info).catch((e: any) =>
          logger.warn({ pda: pdaStr.slice(0, 12), error: e.message }, "LiquidationReactor: accountChange error"),
        );
      },
      "confirmed",
    );
    this.positionSubs.set(pdaStr, subId);
    logger.debug({ pda: pdaStr.slice(0, 12) }, "LiquidationReactor: subscribed to position");
  }

  private async onPositionChange(pda: PublicKey, info: AccountInfo<Buffer>): Promise<void> {
    if (!this.lendingClient) return;
    const pdaStr = pda.toBase58();
    try {
      const decoded = this.lendingClient.decodePosition(pda, info.data);
      if (!decoded) return;
      if (decoded.isLiquidated) {
        // Remove subscription — this position is closed
        const subId = this.positionSubs.get(pdaStr);
        if (subId !== undefined) {
          await this.connection.removeAccountChangeListener(subId);
          this.positionSubs.delete(pdaStr);
        }
        // Reload positions to drop it from the in-memory set
        await this.liquidationHunter.loadFromChain(this.tokenNameByMint);
        logger.info({ pda: pdaStr.slice(0, 12) }, "LiquidationReactor: position liquidated, unsubscribed");
        return;
      }

      // Re-check health immediately with current prices
      await this.check();
    } catch (e: any) {
      logger.debug({ pda: pdaStr.slice(0, 12), error: e.message }, "LiquidationReactor: failed to decode position change");
    }
  }

  // ── Redis fallback mode ──────────────────────────────────────────────────

  private startRedisMode(): void {
    this.liquidationHunter.loadFromRedis().catch(() => {});
    this.redisReloadTimer = setInterval(() => {
      this.liquidationHunter.loadFromRedis().catch(() => {});
    }, this.RESCAN_MS);
  }

  // ── Health check (shared by both modes) ─────────────────────────────────

  private async check(): Promise<void> {
    const now = Date.now();
    if (now - this.lastCheck < this.COOLDOWN_MS) return;
    this.lastCheck = now;

    const userConfig = this.getUserConfig();
    if (userConfig?.liquidations === false) return;
    if (userConfig?.mode === "viewer") return;

    const states = this.poolMonitor.getAllStates();
    const p1 = states.get("pool1");
    const p3 = states.get("pool3");

    const priceMap: Record<string, number> = { fUSDC: 1.0 };
    if (p1 && p1.reserveB > 0) priceMap[this.tokens.tokenB.name] = p1.reserveA / p1.reserveB;
    if (p3 && p3.reserveB > 0) priceMap[this.tokens.tokenC.name] = p3.reserveA / p3.reserveB;

    this.liquidationHunter.applyPrices(priceMap);
    const liqs = this.liquidationHunter.scan();
    if (liqs.length === 0) return;

    const cfg = getConfig();
    const borrowAmount = Math.min(100, cfg.capital.flash_loan_max_usd);

    for (const liq of liqs) {
      const poolEntry = this.findPoolWithToken(liq.collateralToken, states);
      if (!poolEntry) continue;

      const capital = Math.min(borrowAmount * 0.5, Math.max(10, liq.liquidationReward));
      const profitPct = (liq.liquidationReward / Math.max(capital, 1)) * 100;

      const liqArb: ArbOpportunity = {
        type: "liquidation",
        path: `liquidation: ${liq.borrower.slice(0, 8)}… (${liq.collateralToken}/${liq.debtToken}) health=${liq.healthRatio.toFixed(3)}`,
        tokenIn: "fUSDC",
        tokenOut: liq.collateralToken,
        amountIn: capital,
        expectedProfit: liq.liquidationReward,
        profitPercent: parseFloat(profitPct.toFixed(2)),
        pools: [poolEntry.state],
        timestamp: Date.now(),
      };

      // Attach on-chain identity so execute_liq can find the position PDA
      if (liq.positionPda) {
        (liqArb as any).liqMeta = {
          positionPda: liq.positionPda,
          collateralMint: liq.collateralMint,
          debtMint: liq.debtMint,
          collateralAmount: liq.collateralAmount,
          debtAmount: liq.debtAmount,
        };
      }

      const mints: string[] = [];
      const tokenA = this.resolveMint(poolEntry.pool.tokenA);
      const tokenB = this.resolveMint(poolEntry.pool.tokenB);
      if (tokenA && tokenA !== this.baseMint) mints.push(tokenA);
      if (tokenB && tokenB !== this.baseMint) mints.push(tokenB);

      const opp: DiscoveredOpportunity = {
        arb: liqArb,
        poolStates: [poolEntry.state],
        involvedMints: mints,
        poolKeys: [poolEntry.key],
        isTriangular: false,
      };

      logger.info(
        {
          borrower: liq.borrower.slice(0, 8),
          health: liq.healthRatio.toFixed(3),
          reward: liq.liquidationReward.toFixed(4),
          onChain: !!liq.positionPda,
        },
        "LiquidationReactor: liquidatable position detected",
      );

      this.enqueue({ kind: "liq_opportunity", userId: this.userId, opp, poolStates: states, enqueuedAt: Date.now() });
    }
  }

  private findPoolWithToken(
    tokenName: string,
    states: Map<string, PoolState>,
  ): { key: string; pool: any; state: PoolState } | null {
    for (const [key, pool] of Object.entries(this.pools)) {
      const p = pool as any;
      if ((p.tokenA === tokenName || p.tokenB === tokenName) && states.has(key)) {
        return { key, pool: p, state: states.get(key)! };
      }
    }
    return null;
  }

  private resolveMint(tokenName: string): string {
    for (const entry of Object.values(this.tokens) as any[]) {
      if (entry.name === tokenName) return entry.mint ?? "";
    }
    return "";
  }
}
