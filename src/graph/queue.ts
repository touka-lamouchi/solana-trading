/**
 * EventQueue — bounded, FIFO, per-user.
 *
 * Each UserLane owns exactly one of these. Producers (event sources) enqueue;
 * one consumer (the lane's runner loop) dequeues. The queue is in-memory only
 * — events are lost on process restart, which is acceptable for the current
 * design (reactors will re-detect on the next pool change after restart).
 *
 * Drop policy is per kind, decided when the queue is full:
 *   pool_changed       → drop-oldest (latest state matters most)
 *   mempool_pressure   → drop-oldest (latest pressure matters most)
 *   arb_opportunity    → drop-newest (every detection is a real chance to earn)
 *   liq_opportunity    → drop-newest (same)
 *   candle_closed      → never drop (AI refresh must run on every close)
 *   signals_timer      → drop-oldest (latest scan supersedes pending one)
 *
 * Drops are visible: the dropped() counter is read by the lane's metrics and
 * surfaced on /users/:userId/status in Phase 5.
 */

import { logger } from "../utils/logger";
import type { EventKind, LaneEvent } from "./events";

type DropPolicy = "drop_oldest" | "drop_newest" | "never_drop";

const DROP_POLICY: Record<EventKind, DropPolicy> = {
  pool_changed: "drop_oldest",
  mempool_pressure: "drop_oldest",
  arb_opportunity: "drop_newest",
  liq_opportunity: "drop_newest",
  candle_closed: "never_drop",
  signals_timer: "drop_oldest",
};

export interface QueueMetrics {
  size: number;
  enqueuedTotal: number;
  dequeuedTotal: number;
  droppedTotal: number;
  droppedByKind: Record<EventKind, number>;
}

export class EventQueue {
  private readonly capacity: number;
  private readonly userId: string;
  private buf: LaneEvent[] = [];
  private disposed = false;

  private enqueuedTotal = 0;
  private dequeuedTotal = 0;
  private droppedTotal = 0;
  private droppedByKind: Record<EventKind, number> = {
    pool_changed: 0,
    mempool_pressure: 0,
    arb_opportunity: 0,
    liq_opportunity: 0,
    candle_closed: 0,
    signals_timer: 0,
  };

  constructor(opts: { userId: string; capacity?: number }) {
    this.userId = opts.userId;
    this.capacity = opts.capacity ?? 256;
  }

  enqueue(event: LaneEvent): void {
    if (this.disposed) return;

    if (this.buf.length < this.capacity) {
      this.buf.push(event);
      this.enqueuedTotal++;
      return;
    }

    const policy = DROP_POLICY[event.kind];
    if (policy === "drop_newest") {
      this.recordDrop(event.kind, "incoming");
      return;
    }

    if (policy === "drop_oldest") {
      const evicted = this.buf.shift();
      if (evicted) this.recordDrop(evicted.kind, "evicted");
      this.buf.push(event);
      this.enqueuedTotal++;
      return;
    }

    // never_drop — over capacity, but we cannot drop. Grow past capacity and
    // log a warning so backpressure surfaces.
    this.buf.push(event);
    this.enqueuedTotal++;
    logger.warn(
      { userId: this.userId, kind: event.kind, size: this.buf.length, capacity: this.capacity },
      "EventQueue: never_drop kind exceeded capacity",
    );
  }

  dequeue(): LaneEvent | undefined {
    const ev = this.buf.shift();
    if (ev) this.dequeuedTotal++;
    return ev;
  }

  size(): number {
    return this.buf.length;
  }

  metrics(): QueueMetrics {
    return {
      size: this.buf.length,
      enqueuedTotal: this.enqueuedTotal,
      dequeuedTotal: this.dequeuedTotal,
      droppedTotal: this.droppedTotal,
      droppedByKind: { ...this.droppedByKind },
    };
  }

  dispose(): void {
    this.disposed = true;
    this.buf = [];
  }

  private recordDrop(kind: EventKind, _which: "incoming" | "evicted"): void {
    this.droppedTotal++;
    this.droppedByKind[kind]++;
    logger.debug(
      { userId: this.userId, kind, total: this.droppedTotal },
      "EventQueue: dropped event (queue full)",
    );
  }
}
