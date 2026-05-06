import type { EngineDeps } from "../../deps";
import type { GraphStateType } from "../../state";
import { logger } from "../../../utils/logger";

// Executes a directional (own-capital vault swap) for the current slow-path
// opportunity. Short-circuits if executionBlocked is set by any prior guard.
// Appends the TickDetail to state and calls engine.onDetail() for WS broadcast.
export function makeExecuteSlow(deps: EngineDeps) {
  return async (state: GraphStateType): Promise<Partial<GraphStateType>> => {
    logger.debug({ node: "execute_slow" }, "graph: execute_slow");

    if (!state.currentOpp || state.executionBlocked) return {};

    const d = await deps.engine.executeDirectionalTradePublic(
      state.currentOpp,
      state.poolStates,
    );
    d.oppType = state.currentOpp.arb.type;

    logger.info({ stage: d.stage, profit: d.profit, sig: d.signature?.slice(0, 16) }, "[Graph] Slow result");
    deps.engine.onDetail?.(d);

    return { details: [d] };
  };
}
