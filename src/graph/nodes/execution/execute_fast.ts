import type { EngineDeps } from "../../deps";
import type { GraphStateType } from "../../state";
import { logger } from "../../../utils/logger";

// Executes the current fast-path arbitrage. Short-circuits if executionBlocked
// is set by check_guard_fast or check_vault. Appends the TickDetail to state and
// calls engine.onDetail() so UserRegistry can broadcast it over WebSocket.
//
// Routing (Production Arbitrage Phase 3):
//   - When opp.cycle is present (graph-based finder), use executeCyclePublic
//     which handles any hop count via the generic N-hop builder.
//   - Otherwise fall back to executeTriangularArbPublic — preserves vault-routed
//     paths (useVaultArb / useVaultFlashArb) and any non-cycle opportunity
//     shapes that haven't been migrated yet.
export function makeExecuteFast(deps: EngineDeps) {
  return async (state: GraphStateType): Promise<Partial<GraphStateType>> => {
    logger.debug({ node: "execute_fast" }, "graph: execute_fast");

    if (!state.currentOpp || state.executionBlocked) return {};

    const userCfg: any = (deps.engine as any).userConfig ?? {};
    const useVaultRouting = userCfg.useVaultArb === true || userCfg.useVaultFlashArb === true;

    const useCyclePath = Boolean(state.currentOpp.cycle) && !useVaultRouting;

    const d = useCyclePath
      ? await deps.engine.executeCyclePublic(state.currentOpp, state.poolStates)
      : await deps.engine.executeTriangularArbPublic(state.currentOpp, state.poolStates);

    d.oppType = state.currentOpp.arb.type;

    logger.info(
      { stage: d.stage, profit: d.profit, sig: d.signature?.slice(0, 16), path: useCyclePath ? "cycle" : "legacy" },
      "[Graph] Fast result",
    );
    deps.engine.onDetail?.(d);

    return { details: [d] };
  };
}
