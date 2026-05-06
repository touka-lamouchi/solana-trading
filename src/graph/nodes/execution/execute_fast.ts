import type { EngineDeps } from "../../deps";
import type { GraphStateType } from "../../state";
import { logger } from "../../../utils/logger";

// Executes a triangular arbitrage (flash-loan or vault-routed) for the
// current fast-path opportunity. Short-circuits if executionBlocked is set
// by check_guard_fast or check_vault. Appends the TickDetail to state and
// calls engine.onDetail() so UserRegistry can broadcast it over WebSocket.
export function makeExecuteFast(deps: EngineDeps) {
  return async (state: GraphStateType): Promise<Partial<GraphStateType>> => {
    logger.debug({ node: "execute_fast" }, "graph: execute_fast");

    if (!state.currentOpp || state.executionBlocked) return {};

    const d = await deps.engine.executeTriangularArbPublic(
      state.currentOpp,
      state.poolStates,
    );
    d.oppType = state.currentOpp.arb.type;

    logger.info({ stage: d.stage, profit: d.profit, sig: d.signature?.slice(0, 16) }, "[Graph] Fast result");
    deps.engine.onDetail?.(d);

    return { details: [d] };
  };
}
