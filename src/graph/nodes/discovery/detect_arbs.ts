import type { EngineDeps } from "../../deps";
import type { GraphStateType } from "../../state";
import type { DiscoveredOpportunity } from "../../../engine/arb_reactor";
import { getConfig } from "../../../utils/config";
import { logger } from "../../../utils/logger";

// Triangular arb detector. Skips when PoolMonitor is attached — ArbReactor
// handles arb detection event-driven in that case and pre-populates
// filteredOpportunities before this node runs.
export function makeDetectArbs(deps: EngineDeps) {
  return async (state: GraphStateType): Promise<Partial<GraphStateType>> => {
    logger.debug({ node: "detect_arbs" }, "graph: detect_arbs");

    // Fast path: arbEntry already pre-populated filteredOpportunities — skip scan.
    if (state.filteredOpportunities.length > 0) return {};

    // When poolMonitor is running, ArbReactor handles arb detection event-driven.
    // Scanning here on signals_timer would duplicate reactor executions.
    if (deps.poolMonitor?.isRunning()) return {};

    // signals_timer path without poolMonitor: scan using graph pool states.
    const p1 = state.poolStates.get("pool1");
    const p2 = state.poolStates.get("pool2");
    const p3 = state.poolStates.get("pool3");
    if (!p1 || !p2 || !p3) return {};

    const cfg = getConfig();
    const borrowAmount = cfg.capital?.flash_loan_max_usd ?? 500;

    const arbs = await deps.arbDetector.scan(deps.pools, [borrowAmount, 500, 1000, 5000]);

    const opps: DiscoveredOpportunity[] = arbs.map(arb => ({
      arb,
      poolStates: [p1, p2, p3],
      involvedMints: [deps.tokens.tokenB.mint, deps.tokens.tokenC.mint],
      poolKeys: ["pool1", "pool2", "pool3"],
      isTriangular: true,
    }));

    logger.debug({ found: opps.length }, "detect_arbs done");
    return { opportunities: opps };
  };
}
