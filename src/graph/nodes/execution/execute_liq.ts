import type { EngineDeps } from "../../deps";
import type { GraphStateType } from "../../state";
import { logger } from "../../../utils/logger";

// Executes a real on-chain liquidation via the programs-lending program.
// Short-circuits if executionBlocked is set by an upstream guard node.
// Appends the TickDetail and broadcasts via engine.onDetail().
export function makeExecuteLiq(deps: EngineDeps) {
  return async (state: GraphStateType): Promise<Partial<GraphStateType>> => {
    logger.debug({ node: "execute_liq" }, "graph: execute_liq");

    if (!state.currentOpp || state.executionBlocked) return {};

    const d = await deps.engine.executeLiquidationPublic(
      state.currentOpp,
      state.poolStates,
    );
    d.oppType = "liquidation";

    logger.info({ stage: d.stage, profit: d.profit, sig: d.signature?.slice(0, 16) }, "[Graph] Liq result");
    deps.engine.onDetail?.(d);

    return { details: [d] };
  };
}
