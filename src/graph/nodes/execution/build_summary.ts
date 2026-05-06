import type { EngineDeps } from "../../deps";
import type { GraphStateType } from "../../state";
import type { TickResult } from "../../../engine/trading_engine";
import { logger } from "../../../utils/logger";

// Assembles the final TickResult from accumulated state. Called either when
// all opportunities have been processed (pick_next found none) or when
// userConfig.mode === "viewer" (afterFilter routed here directly).
export function makeBuildSummary(_deps: EngineDeps) {
  return async (state: GraphStateType): Promise<Partial<GraphStateType>> => {
    logger.debug({ node: "build_summary" }, "graph: build_summary");

    const executed = state.details.filter(d => d.stage === "executed").length;
    const failed = state.details.filter(d => d.stage === "failed").length;
    const safetyRejected = state.details.filter(d => d.stage === "safety_rejected").length;
    const guardRejected = state.details.filter(d => d.stage === "guard_rejected").length;

    const result: TickResult = {
      poolsScanned: state.poolsScanned,
      opportunitiesFound: state.filteredOpportunities.length,
      safetyRejected,
      guardRejected,
      tradesExecuted: executed,
      tradesFailed: failed,
      details: state.details,
      vault: state.vault ?? null,
    };

    logger.debug({
      poolsScanned: result.poolsScanned,
      opps: result.opportunitiesFound,
      executed: result.tradesExecuted,
    }, "build_summary done");

    return { result };
  };
}
