import type { EngineDeps } from "../../deps";
import type { GraphStateType } from "../../state";
import type { TickDetail } from "../../../engine/trading_engine";
import { logger } from "../../../utils/logger";

// Checks that the user's vault exists, is active, and has a non-zero balance.
// Even flash-loan arbs require an active vault — it represents the user's
// authorization for the bot to trade at all. Skips if no vaultReader is
// configured (single-user mode with no vault wired).
export function makeCheckVault(deps: EngineDeps) {
  return async (state: GraphStateType): Promise<Partial<GraphStateType>> => {
    logger.debug({ node: "check_vault" }, "graph: check_vault");

    if (!state.currentOpp || state.executionBlocked) return {};

    const vaultReader = deps.protection.getVaultReader();
    if (!vaultReader) return {}; // no vault configured — allow

    try {
      const vs = await vaultReader.getState();

      if (!vs.exists) {
        logger.info("  → Vault: BLOCKED — not created");
        return {
          executionBlocked: true,
          details: [detail(state, "vault not created — call createVault via Phantom")],
        };
      }
      if (!vs.isActive) {
        logger.info("  → Vault: BLOCKED — paused by owner");
        return {
          executionBlocked: true,
          details: [detail(state, "vault paused by owner")],
        };
      }
      if (vs.balance <= 0) {
        logger.info("  → Vault: BLOCKED — empty");
        return {
          executionBlocked: true,
          details: [detail(state, "vault balance is zero — deposit first")],
        };
      }

      logger.debug({ balance: vs.balance.toFixed(2) }, "  → Vault: PASSED");
    } catch (e: any) {
      // Vault read failures are non-fatal — allow trade to proceed.
      logger.warn({ error: e.message }, "  → Vault read failed — allowing trade");
    }

    return {};
  };
}

function detail(state: GraphStateType, reason: string): TickDetail {
  return {
    pool: state.currentOpp!.poolKeys.join("+"),
    opportunity: state.currentOpp!.arb.path,
    stage: "guard_rejected",
    reason,
    oppType: state.currentOpp!.arb.type,
  };
}
