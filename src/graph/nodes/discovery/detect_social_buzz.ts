import type { EngineDeps } from "../../deps";
import type { GraphStateType } from "../../state";
import { wrapSignalOpp, resolveSignalMint, borrowCap } from "../utils";
import { getConfig } from "../../../utils/config";
import { logger } from "../../../utils/logger";

// Social buzz detector — scans Reddit/Gemini sentiment signal (cached from the
// SentimentSignal shared with DecisionModel, so no duplicate API calls per tick).
// Uses the mainnet signal mint when ai.data_source=mainnet, trades on devnet pool1.
export function makeDetectSocialBuzz(deps: EngineDeps) {
  return async (state: GraphStateType): Promise<Partial<GraphStateType>> => {
    logger.debug({ node: "detect_social_buzz" }, "graph: detect_social_buzz");

    if (state.userConfig.socialBuzz === false) return {};

    const p1 = state.poolStates.get("pool1");
    if (!p1) return {};

    const cfg = getConfig();
    const signalMint = resolveSignalMint(deps.tokens);
    const tradeMint: string = deps.tokens.tokenB?.mint ?? "";
    const cap = Math.min(borrowCap(), 200);

    const sbOpp = await deps.socialBuzzDetector.scan({
      tokenMint: signalMint,
      tokenName: cfg.ai?.target_symbol || "SOL",
      capital: cap,
      pool: p1,
      baseTokenName: "fUSDC",
      primaryTokenName: "fSOL",
    });

    if (!sbOpp) return {};

    logger.debug({ path: sbOpp.path }, "detect_social_buzz: found");
    return { opportunities: [wrapSignalOpp(sbOpp, p1, tradeMint)] };
  };
}
