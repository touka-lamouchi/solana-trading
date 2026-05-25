/**
 * UserLane — per-user event queue + consumer loop.
 *
 * Each user gets exactly one lane. The lane owns a bounded EventQueue and
 * a single-writer consumer loop that processes events one at a time,
 * maintaining the per-user ordering guarantee (no concurrent graph
 * invocations for the same user).
 *
 * Phase 3: dispatch() is live for signals_timer events. start() installs a
 * 5-second setInterval that enqueues SignalsTimer events; the consumer loop
 * dequeues them and calls signalsEntry(), keeping previousDecision across
 * ticks and surfacing results via the onResult callback.
 *
 * Phase 4 will add arb_opportunity / liq_opportunity / candle_closed dispatch
 * without touching the queue or loop structure.
 *
 * Lifecycle:
 *   start()  — begins the consumer loop + signals timer (idempotent)
 *   enqueue(event) — adds an event; safe to call before or after start()
 *   stop()   — clears the timer, signals the loop to stop, then awaits full
 *              drain of any remaining events (10 s timeout, then force-disposes)
 */

import { EventQueue, QueueMetrics } from "./queue";
import type { LaneEvent } from "./events";
import type { EngineDeps } from "./deps";
import type { CompiledGraph } from "./build";
import type { GraphTickResult } from "./entries";
import type { DecisionResult } from "../layer1_opportunity/decision_model";
import { signalsEntry, candleEntry, arbEntry, liqEntry } from "./entries";
import { logger } from "../utils/logger";

export interface LaneMetrics {
  queue: QueueMetrics;
  processedTotal: number;
  errorTotal: number;
  tripped: boolean;
  trippedReason?: string;
}

export class UserLane {
  private readonly queue: EventQueue;
  readonly userId: string;

  private running = false;
  private loopPromise: Promise<void> | null = null;
  private signalsTimer: ReturnType<typeof setInterval> | null = null;
  private previousDecision: DecisionResult | null = null;

  private static readonly DRAIN_TIMEOUT_MS = 10_000;

  private processedTotal = 0;
  private errorTotal = 0;

  // ASI10 — Rogue Agent kill switch + LLM06 circuit breaker.
  // `tripped` halts all event dispatch for this lane while keeping the loop alive
  // (so it can be reset without a full restart). The breaker trips automatically
  // after CONSECUTIVE_ERROR_LIMIT back-to-back dispatch failures — a misbehaving
  // or compromised lane stops acting instead of spinning on errors.
  private tripped = false;
  private trippedReason: string | undefined;
  private consecutiveErrors = 0;
  private static readonly CONSECUTIVE_ERROR_LIMIT = 5;

  /** Manual kill switch — stop this lane from acting (e.g. operator/auto-pause). */
  trip(reason: string): void {
    this.tripped = true;
    this.trippedReason = reason;
    logger.warn({ userId: this.userId, reason }, "UserLane TRIPPED (ASI10 kill switch) — dispatch halted");
  }

  /** Clear the kill switch and resume dispatch. */
  reset(): void {
    this.tripped = false;
    this.trippedReason = undefined;
    this.consecutiveErrors = 0;
    logger.info({ userId: this.userId }, "UserLane reset — dispatch resumed");
  }

  isTripped(): boolean {
    return this.tripped;
  }

  constructor(
    private readonly deps: EngineDeps,
    private readonly graph: CompiledGraph,
    private readonly onResult: (gtr: GraphTickResult) => void,
  ) {
    this.userId = deps.userId;
    this.queue = new EventQueue({ userId: deps.userId });
  }

  enqueue(event: LaneEvent): void {
    this.queue.enqueue(event);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.runLoop();
    this.signalsTimer = setInterval(() => {
      this.enqueue({ kind: "signals_timer", userId: this.userId, enqueuedAt: Date.now() });
    }, 5_000);
  }

  async stop(): Promise<void> {
    if (this.signalsTimer !== null) {
      clearInterval(this.signalsTimer);
      this.signalsTimer = null;
    }
    this.running = false;
    if (this.loopPromise) {
      const timeout = new Promise<void>(resolve => setTimeout(resolve, UserLane.DRAIN_TIMEOUT_MS));
      await Promise.race([this.loopPromise, timeout]);
      if (this.queue.size() > 0) {
        logger.warn(
          { userId: this.userId, remaining: this.queue.size() },
          "UserLane: drain timeout — force-disposing",
        );
      }
      this.loopPromise = null;
    }
    this.queue.dispose();
  }

  metrics(): LaneMetrics {
    return {
      queue: this.queue.metrics(),
      processedTotal: this.processedTotal,
      errorTotal: this.errorTotal,
      tripped: this.tripped,
      ...(this.trippedReason ? { trippedReason: this.trippedReason } : {}),
    };
  }

  // ── Consumer loop ──────────────────────────────────────────────────────

  private async runLoop(): Promise<void> {
    while (this.running || this.queue.size() > 0) {
      try {
        const event = this.queue.dequeue();
        if (event) {
          await this.dispatch(event);
        } else if (this.running) {
          await sleep(1);
        } else {
          break;
        }
      } catch (e: any) {
        // dispatch() catches its own errors; this guards the loop machinery itself
        logger.error({ userId: this.userId, error: e.message }, "UserLane: loop error — continuing");
      }
    }
  }

  // ── Dispatcher ────────────────────────────────────────────────────────

  private async dispatch(event: LaneEvent): Promise<void> {
    // ASI10 — when tripped, drain events without acting on them. The lane stays
    // alive so an operator can reset() it, but no graph (and thus no trade) runs.
    if (this.tripped) {
      logger.debug({ userId: this.userId, kind: event.kind, reason: this.trippedReason }, "UserLane: event dropped (tripped)");
      return;
    }
    try {
      this.processedTotal++;
      this.consecutiveErrors = 0; // reset optimistically; the catch re-counts on throw
      const latencyMs = Date.now() - event.enqueuedAt;

      if (event.kind === "signals_timer") {
        const userConfig = this.deps.getUserConfig?.() ?? {};
        const gtr = await signalsEntry({
          graph: this.graph,
          userConfig,
          previousDecision: this.previousDecision,
        });
        this.previousDecision = gtr.lastDecision;
        this.onResult(gtr);
        logger.debug({ userId: event.userId, latencyMs }, "UserLane: signals_timer dispatched");
        return;
      }

      if (event.kind === "arb_opportunity") {
        const userConfig = this.deps.getUserConfig?.() ?? {};
        const gtr = await arbEntry({
          graph: this.graph,
          userConfig,
          previousDecision: this.previousDecision,
          opp: event.opp,
        });
        this.previousDecision = gtr.lastDecision;
        this.onResult(gtr);
        logger.debug({ userId: event.userId, latencyMs }, "UserLane: arb_opportunity dispatched");
        return;
      }

      if (event.kind === "liq_opportunity") {
        const userConfig = this.deps.getUserConfig?.() ?? {};
        const gtr = await liqEntry({
          graph: this.graph,
          userConfig,
          previousDecision: this.previousDecision,
          opp: event.opp,
        });
        this.previousDecision = gtr.lastDecision;
        this.onResult(gtr);
        logger.debug({ userId: event.userId, latencyMs }, "UserLane: liq_opportunity dispatched");
        return;
      }

      if (event.kind === "candle_closed") {
        const userConfig = this.deps.getUserConfig?.() ?? {};
        const gtr = await candleEntry({
          graph: this.graph,
          userConfig,
          previousDecision: this.previousDecision,
        });
        this.previousDecision = gtr.lastDecision;
        this.onResult(gtr);
        logger.debug({ userId: event.userId, latencyMs }, "UserLane: candle_closed dispatched");
        return;
      }

      logger.debug({ kind: event.kind, userId: event.userId, latencyMs }, "UserLane: event unhandled (future phase)");
    } catch (e: any) {
      this.errorTotal++;
      this.consecutiveErrors++;
      logger.error(
        { kind: event.kind, error: e.message, consecutive: this.consecutiveErrors },
        "UserLane: dispatch error",
      );
      // LLM06 circuit breaker — too many back-to-back failures means something is
      // systematically wrong; trip the lane rather than keep attempting to act.
      if (this.consecutiveErrors >= UserLane.CONSECUTIVE_ERROR_LIMIT) {
        this.trip(`circuit breaker: ${this.consecutiveErrors} consecutive dispatch errors`);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
