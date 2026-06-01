/**
 * Graph state — the object every node reads from and writes to.
 *
 * Built with LangGraph's Annotation.Root so each field can declare its own
 * reducer. Most fields are last-write-wins; opportunities and details use a
 * concat reducer so parallel discovery branches and the per-opportunity loop
 * can each append without trampling each other.
 *
 * `previousDecision` carries the lastDecision from BEFORE this graph
 * invocation so chart_pattern can read it (it must use the prior tick's
 * decision, not the freshly computed one). `lastDecision` is the freshly
 * computed one, written by ai_decision and read by build_directional.
 *
 * `routedPath` is set by the route node and consumed by the conditional edge
 * after route. It is cleared each time pick_next selects a new opportunity.
 *
 * `result` holds the final TickResult once build_summary populates it; the
 * graph's caller reads `finalState.result`.
 */

import { Annotation } from "@langchain/langgraph";
import type {
  TickDetail,
  MarketSnapshot,
  TickResult,
} from "../engine/trading_engine";
import type { DiscoveredOpportunity } from "../engine/arb_reactor";
import type { PoolState } from "../layer1_opportunity/pure_code/arbitrage_detector";
import type { DecisionResult } from "../layer1_opportunity/decision_model";

export interface ValidPool {
  key: string;
  pool: any;
  state: PoolState;
}

export interface UserConfigSnapshot {
  flashLoans?: boolean;
  yieldGaps?: boolean;
  liquidations?: boolean;
  chartPatterns?: boolean;
  socialBuzz?: boolean;
  copyWhales?: boolean;
  mempoolPressure?: boolean;
  useVaultArb?: boolean;
  useVaultFlashArb?: boolean;
  minProfitMultiplier?: number;
  aiConfidenceThreshold?: number;
  aiWeights?: { chart: number; social: number; whale: number };
  mode?: "live" | "viewer";
  maxTradeUsd?: number;
}

export const GraphState = Annotation.Root({
  // ── Inputs ─────────────────────────────────────────────
  userConfig: Annotation<UserConfigSnapshot>({
    reducer: (_, next) => next,
    default: () => ({}),
  }),

  // ── Discovery outputs ──────────────────────────────────
  poolStates: Annotation<Map<string, PoolState>>({
    reducer: (_, next) => next,
    default: () => new Map(),
  }),
  validPools: Annotation<ValidPool[]>({
    reducer: (_, next) => next,
    default: () => [],
  }),
  poolsScanned: Annotation<number>({
    reducer: (_, next) => next,
    default: () => 0,
  }),

  // Discovery branches concat into this; filter_by_config reads it.
  opportunities: Annotation<DiscoveredOpportunity[]>({
    reducer: (prev, next) => prev.concat(next),
    default: () => [],
  }),
  filteredOpportunities: Annotation<DiscoveredOpportunity[]>({
    reducer: (_, next) => next,
    default: () => [],
  }),

  // Execution loop state — pick_next mutates these.
  remainingOpportunities: Annotation<DiscoveredOpportunity[]>({
    reducer: (_, next) => next,
    default: () => [],
  }),
  currentOpp: Annotation<DiscoveredOpportunity | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),
  // Top-level routed path. Liquidation is NOT a top-level path: it is a
  // sub-branch of "fast" dispatched by opportunity type in the fast tail.
  routedPath: Annotation<"fast" | "slow" | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),
  // Set to true by check_guard / check_vault / check_safety when a trade
  // should be skipped. Cleared at the top of each loop by pick_next.
  executionBlocked: Annotation<boolean>({
    reducer: (_, next) => next,
    default: () => false,
  }),

  // ── AI decision ────────────────────────────────────────
  // previousDecision = lastDecision before this invocation (chart_pattern reads it).
  // lastDecision = freshly computed by ai_decision (build_directional reads it).
  previousDecision: Annotation<DecisionResult | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),
  lastDecision: Annotation<DecisionResult | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),

  // ── Outputs ────────────────────────────────────────────
  marketSnapshot: Annotation<MarketSnapshot | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),
  details: Annotation<TickDetail[]>({
    reducer: (prev, next) => prev.concat(next),
    default: () => [],
  }),
  vault: Annotation<TickResult["vault"]>({
    reducer: (_, next) => next,
    default: () => null,
  }),
  result: Annotation<TickResult | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),
});

export type GraphStateType = typeof GraphState.State;
export type GraphStateUpdate = typeof GraphState.Update;
