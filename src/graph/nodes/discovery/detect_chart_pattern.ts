import type { EngineDeps } from "../../deps";
import type { GraphStateType } from "../../state";
import { wrapSignalOpp, borrowCap } from "../utils";
import { logger } from "../../../utils/logger";

// Chart pattern detector — reads the PREVIOUS tick's decision (state.previousDecision)
// so its signal reflects the regime computed BEFORE this discovery cycle ran.
// Using lastDecision here would create a circular dependency where the detector
// reacts to the signal it helped produce.
export function makeDetectChartPattern(deps: EngineDeps) {
  return async (state: GraphStateType): Promise<Partial<GraphStateType>> => {
    logger.debug({ node: "detect_chart_pattern" }, "graph: detect_chart_pattern");

    if (state.userConfig.chartPatterns === false) return {};

    const p1 = state.poolStates.get("pool1");
    if (!p1) return {};

    const cap = Math.min(borrowCap(), 200);
    const tradeMint: string = deps.tokens.tokenB?.mint ?? "";

    // previousDecision = last tick's result — correct input for chart_pattern.
    const cpOpp = deps.chartPatternDetector.scan(
      state.previousDecision,
      tradeMint,
      cap,
      p1,
      "fUSDC",
      "fSOL",
    );

    if (!cpOpp) return {};

    logger.debug({ path: cpOpp.path }, "detect_chart_pattern: found");
    return { opportunities: [wrapSignalOpp(cpOpp, p1, tradeMint)] };
  };
}
