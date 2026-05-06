import type { EngineDeps } from "../../deps";
import type { GraphStateType } from "../../state";
import type { DiscoveredOpportunity } from "../../../engine/arb_reactor";
import type { ArbOpportunity } from "../../../layer1_opportunity/pure_code/arbitrage_detector";
import { findPoolWithToken, involvedMints, borrowCap } from "../utils";
import { logger } from "../../../utils/logger";

// Yield gap detector. Returns nothing on devnet until a live Raydium/Orca
// APY reader is wired — YieldRateMonitor.scan() returns [] with no seeds.
export function makeDetectYields(deps: EngineDeps) {
  return async (state: GraphStateType): Promise<Partial<GraphStateType>> => {
    logger.debug({ node: "detect_yields" }, "graph: detect_yields");

    if (state.userConfig.yieldGaps === false) return {};

    const gaps = deps.yieldMonitor.scan();
    if (gaps.length === 0) return {};

    const cap = borrowCap();
    const opps: DiscoveredOpportunity[] = [];

    for (const gap of gaps) {
      const poolForToken = findPoolWithToken(gap.token, state.validPools);
      if (!poolForToken) continue;

      const capital = Math.min(cap, 200);
      const yieldArb: ArbOpportunity = {
        type: "yield",
        path: `yield: ${gap.fromProtocol}@${gap.currentApy.toFixed(2)}% → ${gap.toProtocol}@${gap.targetApy.toFixed(2)}% (${gap.token})`,
        tokenIn: "fUSDC",
        tokenOut: gap.token,
        amountIn: capital,
        expectedProfit: capital * (gap.apyDifference / 100) / 8760,
        profitPercent: gap.apyDifference,
        pools: [poolForToken.state],
        timestamp: Date.now(),
      };

      opps.push({
        arb: yieldArb,
        poolStates: [poolForToken.state],
        involvedMints: involvedMints(poolForToken.pool, deps.tokens, deps.baseMint),
        poolKeys: [poolForToken.key],
        isTriangular: false,
      });
    }

    logger.debug({ found: opps.length }, "detect_yields done");
    return { opportunities: opps };
  };
}
