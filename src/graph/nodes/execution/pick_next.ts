import type { EngineDeps } from "../../deps";
import type { GraphStateType } from "../../state";
import { logger } from "../../../utils/logger";

// Pops the head of remainingOpportunities and sets it as currentOpp for this
// iteration. Resets executionBlocked so guard/vault/safety failures from the
// previous iteration don't carry forward. The conditional edge after this
// node routes to route (opp found) or build_summary (queue empty).
export function makePickNext(_deps: EngineDeps) {
  return async (state: GraphStateType): Promise<Partial<GraphStateType>> => {
    logger.debug({ remaining: state.remainingOpportunities.length }, "graph: pick_next");

    const [next, ...rest] = state.remainingOpportunities;
    if (!next) {
      return { currentOpp: null, executionBlocked: false };
    }

    logger.debug({ path: next.arb.path }, "pick_next: selected");
    return {
      currentOpp: next,
      remainingOpportunities: rest,
      routedPath: null,
      executionBlocked: false,
    };
  };
}
