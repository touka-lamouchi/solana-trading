import type { EngineDeps } from "../../deps";
import type { GraphStateType } from "../../state";
import { logger } from "../../../utils/logger";

// Logs whale accumulation/distribution signals for the mints involved in the
// current opportunity (informational only — does not affect execution).
// Shared by both fast and slow paths; the factory is the same, just wired
// at different positions in the graph.
export function makeLogWhaleSignals(deps: EngineDeps) {
  return async (state: GraphStateType): Promise<Partial<GraphStateType>> => {
    logger.debug({ node: "log_whale_signals" }, "graph: log_whale_signals");

    if (!state.currentOpp || state.executionBlocked) return {};

    await deps.engine.logWhaleSignalsPublic(state.currentOpp.involvedMints);
    return {};
  };
}
