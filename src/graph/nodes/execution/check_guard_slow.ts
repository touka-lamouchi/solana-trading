import type { EngineDeps } from "../../deps";
import type { GraphStateType } from "../../state";
import type { TickDetail } from "../../../engine/trading_engine";
import { logger } from "../../../utils/logger";

// Protection guard for the slow path (own-capital trades). Checks both
// effective capital (getEffectiveCapital caps to vault balance) and the
// hard protection guard (daily drawdown, trading hours, auto-pause).
export function makeCheckGuardSlow(deps: EngineDeps) {
  return async (state: GraphStateType): Promise<Partial<GraphStateType>> => {
    logger.debug({ node: "check_guard_slow" }, "graph: check_guard_slow");

    if (!state.currentOpp || state.executionBlocked) return {};

    const amountIn = state.currentOpp.arb.amountIn;

    // Capital cap — vaultReader.getEffectiveCapital limits borrow to vault balance.
    const effective = await deps.protection.getEffectiveCapital(amountIn);
    if (effective.capital < amountIn) {
      logger.info({ reason: effective.reason ?? "capped" }, "  → Capital: BLOCKED");
      const detail: TickDetail = {
        pool: state.currentOpp.poolKeys.join("+"),
        opportunity: state.currentOpp.arb.path,
        stage: "guard_rejected",
        reason: effective.reason ?? "capital capped",
        oppType: state.currentOpp.arb.type,
      };
      return { executionBlocked: true, details: [detail] };
    }

    // Hard guard — drawdown, trading hours, auto-pause.
    const gate = deps.protection.canExecuteTrade(amountIn);
    if (!gate.allowed) {
      logger.info({ reason: gate.reason }, "  → Guard (slow): BLOCKED");
      const detail: TickDetail = {
        pool: state.currentOpp.poolKeys.join("+"),
        opportunity: state.currentOpp.arb.path,
        stage: "guard_rejected",
        reason: gate.reason ?? "blocked by protection",
        oppType: state.currentOpp.arb.type,
      };
      return { executionBlocked: true, details: [detail] };
    }

    logger.debug("  → Guard (slow): PASSED");
    return {};
  };
}
