/**
 * Lane event types.
 *
 * Every event flowing into a per-user UserLane queue is one of these
 * discriminated-union variants. Event sources (PoolMonitor, CandleReactor,
 * MempoolMonitor, SignalsTimer) tag each event with a userId before enqueuing
 * — the queue itself is per-user, but producers are global, so userId is the
 * partition key carried on the event.
 *
 * `kind` drives entry-point selection in the consumer: arb/liq go through the
 * fast execution tail, candle_closed enters at the AI refresh subgraph,
 * signals_timer enters at full discovery, pool_changed is reserved for future
 * graph-driven discovery (today the reactors still own arb/liq detection).
 *
 * `enqueuedAt` lets the consumer measure event-to-execution latency for the
 * Phase 5 backpressure metrics.
 */

import type { DiscoveredOpportunity } from "../engine/arb_reactor";
import type { PoolState } from "../layer1_opportunity/pure_code/arbitrage_detector";
import type { ClosedCandle } from "../infrastructure/candle_reactor";

export type EventKind =
  | "pool_changed"
  | "arb_opportunity"
  | "liq_opportunity"
  | "candle_closed"
  | "signals_timer"
  | "mempool_pressure";

interface BaseEvent {
  userId: string;
  kind: EventKind;
  enqueuedAt: number;
}

export interface PoolChangedEvent extends BaseEvent {
  kind: "pool_changed";
  poolKey: string;
}

export interface ArbOpportunityEvent extends BaseEvent {
  kind: "arb_opportunity";
  opp: DiscoveredOpportunity;
  poolStates: Map<string, PoolState>;
}

export interface LiqOpportunityEvent extends BaseEvent {
  kind: "liq_opportunity";
  opp: DiscoveredOpportunity;
  poolStates: Map<string, PoolState>;
}

export interface CandleClosedEvent extends BaseEvent {
  kind: "candle_closed";
  candle: ClosedCandle;
}

export interface SignalsTimerEvent extends BaseEvent {
  kind: "signals_timer";
}

export interface MempoolPressureEvent extends BaseEvent {
  kind: "mempool_pressure";
  mint: string;
  pressure: number;
}

export type LaneEvent =
  | PoolChangedEvent
  | ArbOpportunityEvent
  | LiqOpportunityEvent
  | CandleClosedEvent
  | SignalsTimerEvent
  | MempoolPressureEvent;
