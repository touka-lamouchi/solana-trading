import type { EngineDeps } from "../../deps";
import type { GraphStateType } from "../../state";
import { logger } from "../../../utils/logger";

// Applies userConfig toggles to filter the collected opportunities.
// Also initialises remainingOpportunities for the execution loop.
// The conditional edge after this node routes to pick_next or build_summary
// depending on userConfig.mode (viewer skips execution entirely).
export function makeFilterByConfig(_deps: EngineDeps) {
  return async (state: GraphStateType): Promise<Partial<GraphStateType>> => {
    logger.debug({ total: state.opportunities.length }, "graph: filter_by_config");

    const cfg = state.userConfig;

    const filtered = state.opportunities.filter(opp => {
      const type = opp.arb.type;
      if (type === "arbitrage" && cfg.flashLoans === false) return false;
      if (type === "yield" && cfg.yieldGaps === false) return false;
      if (type === "liquidation" && cfg.liquidations === false) return false;
      if (type === "chart_pattern" && cfg.chartPatterns === false) return false;
      if (type === "social_buzz" && cfg.socialBuzz === false) return false;
      if (type === "copy_whale" && cfg.copyWhales === false) return false;
      // mempool_pressure and directional always pass through
      return true;
    });

    logger.debug({ filtered: filtered.length }, "filter_by_config done");
    return {
      filteredOpportunities: filtered,
      remainingOpportunities: filtered,
    };
  };
}
