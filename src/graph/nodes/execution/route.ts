import type { EngineDeps } from "../../deps";
import type { GraphStateType } from "../../state";
import { logger } from "../../../utils/logger";

// Top-level routing — two paths only:
//   fast — deterministic, no AI gate. Covers arbitrage AND liquidation; the
//          arb-vs-liq dispatch happens later in the fast tail (afterVault),
//          keyed on opportunity.type, not on routedPath.
//   slow — own-capital swap, AI-gated, full safety pipeline.
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
