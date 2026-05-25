import type { EngineDeps } from "../../deps";
import type { GraphStateType } from "../../state";
import { logger } from "../../../utils/logger";

// AI confidence gate for the slow path. Skips execution if lastDecision is
// absent (AI server down) or if the score is below the user's threshold.
// Sets executionBlocked so all subsequent slow-path nodes short-circuit.
export function makeCheckAiThreshold(_deps: EngineDeps) {
  return async (state: GraphStateType): Promise<Partial<GraphStateType>> => {
    logger.debug({ node: "check_ai_threshold" }, "graph: check_ai_threshold");

    if (!state.currentOpp || state.executionBlocked) return {};

    const threshold = state.userConfig.aiConfidenceThreshold ?? 0.5;
    const score = state.lastDecision?.aiScore;

    // ASI01 / LLM06 — do not let an unreliable AI decision drive an autonomous
    // trade. If the independent sensors contradict each other (one may be
    // poisoned/manipulated), block the slow path regardless of the raw score.
    if (state.lastDecision && state.lastDecision.reliable === false) {
      logger.warn(
        { agreement: state.lastDecision.signalAgreement, reason: state.lastDecision.disagreementReason },
        "  → AI threshold: BLOCKED (signals disagree — unreliable, ASI01)",
      );
      return { executionBlocked: true };
    }

    if (score === undefined || score < threshold) {
      logger.debug(
        { score: score?.toFixed(2) ?? "none", threshold },
        "  → AI threshold: BLOCKED",
      );
      return { executionBlocked: true };
    }

    logger.debug({ score: score.toFixed(2), threshold }, "  → AI threshold: PASSED");
    return {};
  };
}
