import type { EngineDeps } from "../../deps";
import type { GraphStateType } from "../../state";
import { wrapSignalOpp, resolveSignalMint, borrowCap } from "../utils";
import { logger } from "../../../utils/logger";

// Whale copy detector — reads WhaleCache (populated by WhaleTracker on mainnet)
// to detect institutional accumulation/distribution. Reuses the WhaleSignal
// shared with DecisionModel — no additional RPC calls per tick.
export function makeDetectWhaleCopy(deps: EngineDeps) {
  return async (state: GraphStateType): Promise<Partial<GraphStateType>> => {
    logger.debug({ node: "detect_whale_copy" }, "graph: detect_whale_copy");

    if (state.userConfig.copyWhales === false) return {};

    const p1 = state.poolStates.get("pool1");
    if (!p1) return {};

    const signalMint = resolveSignalMint(deps.tokens);
    const tradeMint: string = deps.tokens.tokenB?.mint ?? "";
    const cap = Math.min(borrowCap(), 200);

    const wcOpp = await deps.whaleCopyDetector.scan({
      tokenMint: signalMint,
      capital: cap,
      pool: p1,
      baseTokenName: "fUSDC",
      primaryTokenName: "fSOL",
    });

    if (!wcOpp) return {};

    logger.debug({ path: wcOpp.path }, "detect_whale_copy: found");
    return { opportunities: [wrapSignalOpp(wcOpp, p1, tradeMint)] };
  };
}
