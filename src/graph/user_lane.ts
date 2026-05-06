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
    try {
      this.processedTotal++;
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
      logger.error({ kind: event.kind, error: e.message }, "UserLane: dispatch error");
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
