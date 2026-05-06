import type { EngineDeps } from "../../deps";
import type { GraphStateType } from "../../state";
import type { TickDetail } from "../../../engine/trading_engine";
import { logger } from "../../../utils/logger";

// Runs the S1→S4 safety pipeline on every mint involved in the current
// slow-path opportunity. Stops on the first failure. fUSDC (baseMint) is
// implicitly trusted — the engine never safety-checks it since we minted it.
export function makeCheckSafety(deps: EngineDeps) {
  return async (state: GraphStateType): Promise<Partial<GraphStateType>> => {
    logger.debug({ node: "check_safety" }, "graph: check_safety");

    if (!state.currentOpp || state.executionBlocked) return {};

    for (const mint of state.currentOpp.involvedMints) {
      if (mint === deps.baseMint) continue; // trusted base token

      const poolAddr = state.currentOpp.poolStates[0]?.address;
      const result = await deps.safety.check(mint, poolAddr);

      if (!result.passed) {
        logger.info({ mint: mint.slice(0, 8), failedAt: result.failedAt }, "  → Safety: FAILED");
        const detail: TickDetail = {
          pool: state.currentOpp.poolKeys.join("+"),
          opportunity: state.currentOpp.arb.path,
          stage: "safety_rejected",
          reason: result.failedAt ?? "safety check failed",
          oppType: state.currentOpp.arb.type,
        };
        return { executionBlocked: true, details: [detail] };
      }
    }

    logger.debug("  → Safety: PASSED");
    return {};
  };
}
