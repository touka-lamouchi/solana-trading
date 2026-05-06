import type { EngineDeps } from "../../deps";
import type { GraphStateType } from "../../state";
import type { TickDetail } from "../../../engine/trading_engine";
import { logger } from "../../../utils/logger";

// Protection guard for the fast path (flash-loan arb / liquidation).
// Flash loans are atomic — if repay is underfunded the whole tx reverts —
// so capital-at-risk is effectively zero. We pass 0 to canExecuteTrade().
// If blocked, sets executionBlocked so check_vault and execute_fast short-circuit.
export function makeCheckGuardFast(deps: EngineDeps) {
  return async (state: GraphStateType): Promise<Partial<GraphStateType>> => {
    logger.debug({ node: "check_guard_fast" }, "graph: check_guard_fast");

    if (!state.currentOpp || state.executionBlocked) return {};

    const gate = deps.protection.canExecuteTrade(0);
    if (!gate.allowed) {
      logger.info({ reason: gate.reason }, "  → Guard (fast): BLOCKED");
      const detail: TickDetail = {
        pool: state.currentOpp.poolKeys.join("+"),
        opportunity: state.currentOpp.arb.path,
        stage: "guard_rejected",
        reason: gate.reason ?? "blocked by protection",
        oppType: state.currentOpp.arb.type,
      };
      return { executionBlocked: true, details: [detail] };
    }

    logger.debug("  → Guard (fast): PASSED");
    return {};
  };
}
