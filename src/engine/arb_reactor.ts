import { PoolMonitor } from "../infrastructure/pool_monitor";
import { ArbitrageDetector, ArbOpportunity, PoolState } from "../layer1_opportunity/pure_code/arbitrage_detector";
import { getConfig } from "../utils/config";
import { logger } from "../utils/logger";
import type { ArbOpportunityEvent } from "../graph/events";

export interface DiscoveredOpportunity {
  arb: ArbOpportunity;
  poolStates: PoolState[];
  involvedMints: string[];
  poolKeys: string[];
  isTriangular: boolean;
}

/**
 * ArbReactor — event-driven triangular arbitrage detector.
 *
 * Listens to PoolMonitor "change" events. Every time any pool vault
 * balance changes (i.e., a swap landed on-chain), it immediately runs
 * the triangular arb math against the in-memory states — no RPC call.
 *
 * If a profitable opportunity is found and the cooldown has elapsed,
 * the onOpportunity callback is invoked with the opportunity and the
 * current pool state map.
 *
 * Cooldown prevents spamming flash-loan submissions when a single
 * account change fires multiple subscription callbacks in quick
 * succession (both vaultA and vaultB subscriptions may fire within
 * the same slot).
 */
export class ArbReactor {
  private poolMonitor: PoolMonitor;
  private arbDetector: ArbitrageDetector;
  private tokens: any;
  private enqueue: (event: ArbOpportunityEvent) => void;
  private getUserConfig: () => any;
  private userId: string;

  private lastSubmission = 0;
  private readonly COOLDOWN_MS = 500;

  constructor(opts: {
    poolMonitor: PoolMonitor;
    arbDetector: ArbitrageDetector;
    tokens: any;
    userId: string;
    enqueue: (event: ArbOpportunityEvent) => void;
    getUserConfig: () => any;
  }) {
    this.poolMonitor = opts.poolMonitor;
    this.arbDetector = opts.arbDetector;
    this.tokens = opts.tokens;
    this.userId = opts.userId;
    this.enqueue = opts.enqueue;
    this.getUserConfig = opts.getUserConfig;
  }

  start(): void {
    this.poolMonitor.on("change", (_poolKey: string) => {
      this.check().catch((e: any) =>
        logger.warn({ error: e.message }, "ArbReactor: check error"),
      );
    });
    logger.info("ArbReactor started — listening for pool changes");
  }

  private async check(): Promise<void> {
    // Respect cooldown so we don't spam submissions when both vaultA and
    // vaultB subscriptions fire within the same slot.
    const now = Date.now();
    if (now - this.lastSubmission < this.COOLDOWN_MS) return;

    // User may have disabled flash loans.
    const userConfig = this.getUserConfig();
    if (userConfig?.flashLoans === false) return;
    if (userConfig?.mode === "viewer") return;

    const states = this.poolMonitor.getAllStates();
    const p1 = states.get("pool1");
    const p2 = states.get("pool2");
    const p3 = states.get("pool3");
    if (!p1 || !p2 || !p3) return;

    const cfg = getConfig();
    const borrowAmount = Math.min(100, cfg.capital.flash_loan_max_usd);

    const arb = this.arbDetector.checkTriangularArbFromStates(p1, p2, p3, borrowAmount);
    if (!arb) return;

    this.lastSubmission = now; // optimistic lock before enqueue

    logger.info(
      { path: arb.path, profit: arb.expectedProfit.toFixed(4), pct: arb.profitPercent.toFixed(2) },
      "ArbReactor: opportunity detected — enqueuing",
    );

    const opp: DiscoveredOpportunity = {
      arb,
      poolStates: [p1, p2, p3],
      involvedMints: [this.tokens.tokenB.mint, this.tokens.tokenC.mint],
      poolKeys: ["pool1", "pool2", "pool3"],
      isTriangular: true,
    };

    this.enqueue({ kind: "arb_opportunity", userId: this.userId, opp, poolStates: states, enqueuedAt: Date.now() });
  }
}
