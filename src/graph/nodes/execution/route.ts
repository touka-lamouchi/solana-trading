import type { EngineDeps } from "../../deps";
import type { GraphStateType } from "../../state";
import { logger } from "../../../utils/logger";

// Routes the current opportunity to:
//   fast — arbitrage (flash loan, no capital risk)
//   liq  — liquidation (calls programs-lending liquidate instruction)
//   slow — yield/directional (own-capital swap, AI-gated, full safety pipeline)
// Sets routedPath in state; the conditional edge after this node reads it.
export function makeRoute(deps: EngineDeps) {
  return async (state: GraphStateType): Promise<Partial<GraphStateType>> => {
    logger.debug({ node: "route" }, "graph: route");

    if (!state.currentOpp) return {};

    const routed = deps.router.route(state.currentOpp.arb);
    logger.debug({ path: routed.path, reason: routed.reason }, "route done");

    return { routedPath: routed.path };
  };
}
