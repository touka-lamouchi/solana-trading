import type { EngineDeps } from "../../deps";
import type { GraphStateType } from "../../state";
import type { AIWeights } from "../../../layer1_opportunity/decision_model";
import { logger } from "../../../utils/logger";

const DEFAULT_WEIGHTS: AIWeights = { chart: 45, social: 30, whale: 25 };

// Runs the 5-signal aggregator (LSTM regime + GRU vol + sentiment + whale +
// mempool) and writes lastDecision into state. chart_pattern reads the
// PREVIOUS tick's decision via state.previousDecision — it must not read
// lastDecision (which reflects this tick's market, not last tick's signal).
export function makeAiDecision(deps: EngineDeps) {
  return async (state: GraphStateType): Promise<Partial<GraphStateType>> => {
    logger.debug({ node: "ai_decision" }, "graph: ai_decision");

    const weights: AIWeights = state.userConfig.aiWeights ?? DEFAULT_WEIGHTS;

    try {
      const primaryMint = deps.ingestionService.isMainnetMode()
        ? deps.ingestionService.getMainnetMint()
        : (deps.tokens.tokenB?.mint ?? "");

      const [regimeFeatures, gruFeatures] = await Promise.all([
        deps.ingestionService.getRegimeFeatures(primaryMint),
        deps.ingestionService.getGRUFeatures(primaryMint),
      ]);

      const lastDecision = await deps.decisionModel.computeScore(
        primaryMint, weights, "SOL", { regimeFeatures, gruFeatures },
      );

      logger.debug({
        aiScore: lastDecision.aiScore,
        direction: lastDecision.direction,
        regime: lastDecision.regime,
      }, "ai_decision done");

      return { lastDecision };
    } catch (e: any) {
      logger.warn({ error: e.message }, "ai_decision failed (non-fatal)");
      return {};
    }
  };
}
