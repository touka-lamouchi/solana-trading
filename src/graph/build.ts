/**
 * Graph wiring (Phase 1b — real discovery node bodies).
 *
 * Each node is now a closure over EngineDeps rather than a stub.
 * Execution nodes (pick_next … build_summary) remain stubs until Phase 1c.
 * The topology (edges, conditionals) is unchanged from Phase 1a.
 *
 *   START → scan_pools
 *      ↓
 *      ├─ detect_arbs ─────────────────┐
 *      ├─ detect_yields ───────────────┤
 *      ├─ detect_liquidations ─────────┤
 *      └─ ingest_candles → ai_decision─┤
 *                            ↓         │
 *                            ├─ detect_chart_pattern ─────┤
 *                            ├─ detect_social_buzz ───────┤
 *                            ├─ detect_whale_copy ────────┤
 *                            ├─ detect_mempool_pressure ──┤
 *                            └─ build_directional ────────┤
 *                                                         ↓
 *                                              filter_by_config
 *                                                         ↓
 *                                              (viewer? → build_summary)
 *                                                         ↓
 *                                            ┌──── pick_next ◄──────┐
 *                                            │       ↓              │
 *                                            │   (none? → build_summary)
 *                                            │       ↓              │
 *                                            │     route            │
 *                                            │   ┌───┴───┐          │
 *                                            │  fast    slow        │
 *                                            │   ↓       ↓          │
 *                                            │ log_whale  check_ai_threshold
 *                                            │   ↓       ↓          │
 *                                            │ check_guard  check_safety
 *                                            │   ↓       ↓          │
 *                                            │ check_vault  log_whale_signals
 *                                            │   ↓       ↓          │
 *                                            │ execute_fast  check_guard
 *                                            │   ↓       ↓          │
 *                                            │   │   execute_slow   │
 *                                            │   └───┬───┘          │
 *                                            └───────┴──────────────┘
 *                                                         ↓
 *                                                   build_summary → END
 */

import { StateGraph, START, END } from "@langchain/langgraph";
import { GraphState, type GraphStateType } from "./state";
import type { EngineDeps } from "./deps";

// ── Discovery node factories ────────────────────────────
import { makeScanPools } from "./nodes/discovery/scan_pools";
import { makeDetectArbs } from "./nodes/discovery/detect_arbs";
import { makeDetectYields } from "./nodes/discovery/detect_yields";
import { makeDetectLiquidations } from "./nodes/discovery/detect_liquidations";
import { makeIngestCandles } from "./nodes/discovery/ingest_candles";
import { makeAiDecision } from "./nodes/discovery/ai_decision";
import { makeDetectChartPattern } from "./nodes/discovery/detect_chart_pattern";
import { makeDetectSocialBuzz } from "./nodes/discovery/detect_social_buzz";
import { makeDetectWhaleCopy } from "./nodes/discovery/detect_whale_copy";
import { makeDetectMempoolPressure } from "./nodes/discovery/detect_mempool_pressure";
import { makeBuildDirectional } from "./nodes/discovery/build_directional";
import { makeFilterByConfig } from "./nodes/discovery/filter_by_config";

// ── Execution node factories ────────────────────────────
import { makePickNext } from "./nodes/execution/pick_next";
import { makeRoute } from "./nodes/execution/route";
import { makeLogWhaleSignals } from "./nodes/execution/log_whale_signals";
import { makeCheckGuardFast } from "./nodes/execution/check_guard_fast";
import { makeCheckVault } from "./nodes/execution/check_vault";
import { makeExecuteFast } from "./nodes/execution/execute_fast";
import { makeCheckAiThreshold } from "./nodes/execution/check_ai_threshold";
import { makeCheckSafety } from "./nodes/execution/check_safety";
import { makeCheckGuardSlow } from "./nodes/execution/check_guard_slow";
import { makeExecuteSlow } from "./nodes/execution/execute_slow";
import { makeExecuteLiq } from "./nodes/execution/execute_liq";
import { makeBuildSummary } from "./nodes/execution/build_summary";
import { makeEmitStatus } from "./nodes/execution/emit_status";

// ── Conditional edge predicates ─────────────────────────

function afterFilter(state: GraphStateType): "pick_next" | "build_summary" {
  if (state.userConfig.mode === "viewer") return "build_summary";
  return "pick_next";
}

function afterPickNext(state: GraphStateType): "route" | "build_summary" {
  return state.currentOpp ? "route" : "build_summary";
}

// Top-level routing: fast vs slow only. Liquidation is a sub-branch of fast,
// resolved later by afterVault on opportunity type.
function afterRoute(state: GraphStateType): "log_whale_signals_fast" | "check_ai_threshold" {
  return state.routedPath === "fast" ? "log_whale_signals_fast" : "check_ai_threshold";
}

// Fast-tail dispatch: after the shared protection + vault checks, send
// liquidations to the lending executor and everything else (arbitrage) to the
// generic cycle / triangular executor.
function afterVault(state: GraphStateType): "execute_liq" | "execute_fast" {
  return state.currentOpp?.arb.type === "liquidation" ? "execute_liq" : "execute_fast";
}

// ── Graph builder ───────────────────────────────────────
export function buildGraph(deps: EngineDeps) {
  const g = new StateGraph(GraphState)

    // Discovery — real bodies
    .addNode("scan_pools", makeScanPools(deps))
    .addNode("detect_arbs", makeDetectArbs(deps))
    .addNode("detect_yields", makeDetectYields(deps))
    .addNode("detect_liquidations", makeDetectLiquidations(deps))
    .addNode("ingest_candles", makeIngestCandles(deps))
    .addNode("ai_decision", makeAiDecision(deps))
    .addNode("detect_chart_pattern", makeDetectChartPattern(deps))
    .addNode("detect_social_buzz", makeDetectSocialBuzz(deps))
    .addNode("detect_whale_copy", makeDetectWhaleCopy(deps))
    .addNode("detect_mempool_pressure", makeDetectMempoolPressure(deps))
    .addNode("build_directional", makeBuildDirectional(deps))
    .addNode("filter_by_config", makeFilterByConfig(deps))

    // Execution loop
    .addNode("pick_next", makePickNext(deps))
    .addNode("route", makeRoute(deps))

    // Fast path
    .addNode("log_whale_signals_fast", makeLogWhaleSignals(deps))
    .addNode("check_guard_fast", makeCheckGuardFast(deps))
    .addNode("check_vault", makeCheckVault(deps))
    .addNode("execute_fast", makeExecuteFast(deps))

    // Slow path
    .addNode("check_ai_threshold", makeCheckAiThreshold(deps))
    .addNode("check_safety", makeCheckSafety(deps))
    .addNode("log_whale_signals_slow", makeLogWhaleSignals(deps))
    .addNode("check_guard_slow", makeCheckGuardSlow(deps))
    .addNode("execute_slow", makeExecuteSlow(deps))

    // Liquidation path
    .addNode("execute_liq", makeExecuteLiq(deps))

    // Summary
    .addNode("build_summary", makeBuildSummary(deps))
    .addNode("emit_status", makeEmitStatus(deps));

  // ── Edges ──────────────────────────────────────────────

  // Discovery fan-out
  g.addEdge(START, "scan_pools");
  g.addEdge("scan_pools", "detect_arbs");
  g.addEdge("scan_pools", "detect_yields");
  g.addEdge("scan_pools", "detect_liquidations");
  g.addEdge("scan_pools", "ingest_candles");
  g.addEdge("ingest_candles", "ai_decision");

  // AI fan-out
  g.addEdge("ai_decision", "detect_chart_pattern");
  g.addEdge("ai_decision", "detect_social_buzz");
  g.addEdge("ai_decision", "detect_whale_copy");
  g.addEdge("ai_decision", "detect_mempool_pressure");
  g.addEdge("ai_decision", "build_directional");

  // Barrier: every discovery branch must complete before filter_by_config runs.
  g.addEdge(
    [
      "detect_arbs",
      "detect_yields",
      "detect_liquidations",
      "detect_chart_pattern",
      "detect_social_buzz",
      "detect_whale_copy",
      "detect_mempool_pressure",
      "build_directional",
    ],
    "filter_by_config",
  );

  // Viewer mode skips execution entirely.
  g.addConditionalEdges("filter_by_config", afterFilter, {
    pick_next: "pick_next",
    build_summary: "build_summary",
  });

  // Per-opportunity loop
  g.addConditionalEdges("pick_next", afterPickNext, {
    route: "route",
    build_summary: "build_summary",
  });

  g.addConditionalEdges("route", afterRoute, {
    log_whale_signals_fast: "log_whale_signals_fast",
    check_ai_threshold: "check_ai_threshold",
  });

  // Fast path tail (shared by arbitrage and liquidation):
  //   log whale signals → protection check → vault check → dispatch by type
  g.addEdge("log_whale_signals_fast", "check_guard_fast");
  g.addEdge("check_guard_fast", "check_vault");
  g.addConditionalEdges("check_vault", afterVault, {
    execute_fast: "execute_fast",
    execute_liq: "execute_liq",
  });
  g.addEdge("execute_fast", "pick_next");

  // Slow path tail
  g.addEdge("check_ai_threshold", "check_safety");
  g.addEdge("check_safety", "log_whale_signals_slow");
  g.addEdge("log_whale_signals_slow", "check_guard_slow");
  g.addEdge("check_guard_slow", "execute_slow");
  g.addEdge("execute_slow", "pick_next");

  // Liquidation path tail
  g.addEdge("execute_liq", "pick_next");

  g.addEdge("build_summary", "emit_status");
  g.addEdge("emit_status", END);

  return g.compile();
}

export type CompiledGraph = ReturnType<typeof buildGraph>;
