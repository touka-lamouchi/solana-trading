/**
 * Entry-point selectors.
 *
 * The graph has multiple entry points depending on what triggered it. Each
 * entry function builds the initial state for that event kind and invokes
 * the compiled graph. The graph itself always starts at START → scan_pools,
 * but for arb / liq events most of the discovery branches short-circuit
 * because the opportunity is already known — the relevant work is the
 * execution tail.
 *
 * Phase 1a wires the entries to the stub graph so the topology is callable.
 * Phase 1b/1c will plug real node bodies underneath without changing this
 * file's signatures.
 *
 * Entry points:
 *   signalsEntry   — periodic SignalsTimer event; runs full discovery + execution
 *   candleEntry    — Binance candle close; refreshes AI then runs signal detectors
 *   arbEntry       — ArbReactor detected an opportunity; goes straight to execution
 *   liqEntry       — LiquidationReactor detected; same as arbEntry
 *
 * For arb/liq the initial state pre-populates `filteredOpportunities` with a
 * single item and skips the discovery branches by short-circuiting them at
 * runtime (they no-op when poolStates is empty / opportunities is already set).
 * The clean way to do this is multiple compiled graphs with different START
 * edges, but a single graph with branch short-circuits is simpler for Phase 1a
 * and avoids duplicating compilation cost. We can split later if needed.
 */

import type { CompiledGraph } from "./build";
import type { GraphStateType } from "./state";
import type { UserConfigSnapshot } from "./state";
import type { DiscoveredOpportunity } from "../engine/arb_reactor";
import type { DecisionResult } from "../layer1_opportunity/decision_model";
import type { TickResult } from "../engine/trading_engine";

export interface GraphTickResult {
  tick: TickResult;
  lastDecision: DecisionResult | null;
}

interface EntryContext {
  graph: CompiledGraph;
  userConfig: UserConfigSnapshot;
  previousDecision: DecisionResult | null;
}

const EMPTY_TICK: TickResult = {
  poolsScanned: 0,
  opportunitiesFound: 0,
  safetyRejected: 0,
  guardRejected: 0,
  tradesExecuted: 0,
  tradesFailed: 0,
  details: [],
  vault: null,
};

async function invoke(
  graph: CompiledGraph,
  initial: Partial<GraphStateType>,
): Promise<GraphTickResult> {
  const finalState = (await graph.invoke(initial)) as GraphStateType;
  return {
    tick: finalState.result ?? EMPTY_TICK,
    lastDecision: finalState.lastDecision ?? null,
  };
}

export async function signalsEntry(ctx: EntryContext): Promise<GraphTickResult> {
  return invoke(ctx.graph, {
    userConfig: ctx.userConfig,
    previousDecision: ctx.previousDecision,
  });
}

export async function candleEntry(ctx: EntryContext): Promise<GraphTickResult> {
  return invoke(ctx.graph, {
    userConfig: ctx.userConfig,
    previousDecision: ctx.previousDecision,
  });
}

export async function arbEntry(
  ctx: EntryContext & { opp: DiscoveredOpportunity },
): Promise<GraphTickResult> {
  return invoke(ctx.graph, {
    userConfig: ctx.userConfig,
    previousDecision: ctx.previousDecision,
    filteredOpportunities: [ctx.opp],
    remainingOpportunities: [ctx.opp],
  });
}

export async function liqEntry(
  ctx: EntryContext & { opp: DiscoveredOpportunity },
): Promise<GraphTickResult> {
  return invoke(ctx.graph, {
    userConfig: ctx.userConfig,
    previousDecision: ctx.previousDecision,
    filteredOpportunities: [ctx.opp],
    remainingOpportunities: [ctx.opp],
  });
}
