import type { EngineDeps } from "../../deps";
import type { GraphStateType } from "../../state";
import { buildDirectionalOpp } from "../utils";
import { logger } from "../../../utils/logger";

// Builds a directional opportunity from the freshly computed AI decision.
// Fires only when direction != "neutral" AND aiScore >= user threshold.
// The resulting opportunity flows through the slow execution path (S1-S4
// safety + AI gate + protection guard).
export function makeBuildDirectional(deps: EngineDeps) {
  return async (state: GraphStateType): Promise<Partial<GraphStateType>> => {
    logger.debug({ node: "build_directional" }, "graph: build_directional");

    const decision = state.lastDecision;
    if (!decision || decision.direction === "neutral") return {};

    const aiThreshold = state.userConfig.aiConfidenceThreshold ?? 0.5;
    if (decision.aiScore < aiThreshold) return {};

    const p1 = state.poolStates.get("pool1");
    if (!p1) return {};

    const opp = buildDirectionalOpp(decision, p1, deps.tokens);

    logger.debug({ direction: decision.direction, score: decision.aiScore }, "build_directional: found");
    return { opportunities: [opp] };
  };
}
