import { PoolMonitor } from "../infrastructure/pool_monitor";
import { ArbitrageDetector, ArbOpportunity, PoolState } from "../layer1_opportunity/pure_code/arbitrage_detector";
import { findRankedCycles, cycleLabel, type RankedCycle } from "../layer1_opportunity/pure_code/arb_graph_builder";
import { getConfig } from "../utils/config";
import { logger } from "../utils/logger";
import type { ArbOpportunityEvent } from "../graph/events";

export interface DiscoveredOpportunity {
  arb: ArbOpportunity;
  poolStates: PoolState[];
  involvedMints: string[];
  poolKeys: string[];
  isTriangular: boolean;
  /**
   * New (Production Arbitrage Phase 2): graph-based cycle metadata.
   * Set when the opportunity came from the dynamic finder. Phase 3 executor
   * will consume this directly. Phase 2 leaves the legacy fields populated
   * so the existing `executeTriangularArbPublic` path keeps working.
   */
  cycle?: RankedCycle;
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
  /** Retained for backwards-compat with constructors in trading_engine.ts;
   *  no longer consulted now that the graph-based finder replaces it. */
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

    // Resolve base mint (fUSDC by default — what the flash-loan vault holds).
    const baseMint = this.tokens?.tokenA?.mint;
    if (!baseMint) return;

    // Build the graph fresh from the live pool snapshot every check. Cheap.
    const records = this.poolMonitor.getRecords();
    if (records.length === 0) return;

    const cfg = getConfig();
    const userMaxTrade = typeof userConfig?.maxTradeUsd === "number" ? userConfig.maxTradeUsd : Infinity;
    const flashCap = cfg.capital?.flash_loan_max_usd ?? 1000;
    const minProfitMultiplier = typeof userConfig?.minProfitMultiplier === "number"
      ? userConfig.minProfitMultiplier
      : 1.5;

    const ranked = findRankedCycles(records, {
      baseMint,
      minIn: 1,
      maxIn: Math.min(userMaxTrade, flashCap),
      // Estimated total fee per cycle in fUSDC. Conservative default; Phase 4
      // will replace with a live FeeCalculator estimate.
      estimatedFeeBase: 0.05,
      minProfitMultiplier,
      minDepth: 2,
      maxDepth: 4,
      maxCycles: 256,
    });

    if (ranked.length === 0) {
      // Diagnostic: when nothing clears the gate, log a small summary so the
      // user can tell whether the gap is too small or the fee gate is too tight.
      // Run a single cycle simulation at maxIn to surface the headline gross
      // profit even when net is negative.
      const { findCycles: _fc } = await import("../layer1_opportunity/pure_code/cycle_finder");
      const { simulateCycle: _sc } = await import("../layer1_opportunity/pure_code/cycle_simulator");
      const { buildGraph: _bg } = await import("../layer1_opportunity/pure_code/arb_graph_builder");
      const probeAmount = Math.min(userMaxTrade, flashCap);
      const probeGraph = _bg(records);
      const probeCycles = _fc(probeGraph, baseMint, { minDepth: 2, maxDepth: 4, maxCycles: 64 });
      let bestProbeGross = -Infinity;
      let bestProbeHops = 0;
      for (const c of probeCycles) {
        const sim = _sc(c, probeAmount);
        if (sim && sim.grossProfit > bestProbeGross) {
          bestProbeGross = sim.grossProfit;
          bestProbeHops = c.length;
        }
      }
      logger.info(
        {
          pools: records.length,
          cycles: probeCycles.length,
          probeAmount: probeAmount.toFixed(0),
          bestGrossAtMaxIn: isFinite(bestProbeGross) ? bestProbeGross.toFixed(4) : "n/a",
          bestHops: bestProbeHops,
          minProfitMultiplier,
        },
        "ArbReactor: no profitable cycles this tick (diagnostic probe)",
      );
      return;
    }
    const best = ranked[0]!;

    // Backwards-compatible legacy ArbOpportunity payload — Phase 3 executor
    // will switch to consuming `opp.cycle` directly.
    const states = this.poolMonitor.getAllStates();
    const poolKeys = best.cycle.map(e => e.poolKey);
    const poolStates: PoolState[] = poolKeys
      .map(k => states.get(k))
      .filter((s): s is PoolState => Boolean(s));
    const involvedMints = uniqueMints(best, baseMint);

    const arb: ArbOpportunity = {
      type: "arbitrage",
      path: cycleLabel(best.cycle),
      tokenIn: best.cycle[0]!.symbolIn ?? best.cycle[0]!.fromMint,
      tokenOut: best.cycle[best.cycle.length - 1]!.symbolOut ?? best.cycle[best.cycle.length - 1]!.toMint,
      amountIn: best.amountIn,
      expectedProfit: best.netProfit,
      profitPercent: (best.netProfit / Math.max(best.amountIn, 1e-9)) * 100,
      pools: poolStates,
      timestamp: Date.now(),
    };

    this.lastSubmission = now;

    logger.info(
      {
        path: arb.path,
        amountIn: arb.amountIn.toFixed(4),
        netProfit: best.netProfit.toFixed(4),
        gross: best.grossProfit.toFixed(4),
        hops: best.cycle.length,
        candidates: ranked.length,
      },
      "ArbReactor: cycle detected — enqueuing",
    );

    const opp: DiscoveredOpportunity = {
      arb,
      poolStates,
      involvedMints,
      poolKeys,
      isTriangular: best.cycle.length === 3,
      cycle: best,
    };

    this.enqueue({ kind: "arb_opportunity", userId: this.userId, opp, poolStates: states, enqueuedAt: Date.now() });
  }
}

function uniqueMints(rc: RankedCycle, baseMint: string): string[] {
  const seen = new Set<string>();
  for (const edge of rc.cycle) {
    if (edge.fromMint !== baseMint) seen.add(edge.fromMint);
    if (edge.toMint !== baseMint) seen.add(edge.toMint);
  }
  return Array.from(seen);
}
