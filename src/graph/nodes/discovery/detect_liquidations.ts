import type { EngineDeps } from "../../deps";
import type { GraphStateType } from "../../state";
import type { DiscoveredOpportunity } from "../../../engine/arb_reactor";
import type { ArbOpportunity } from "../../../layer1_opportunity/pure_code/arbitrage_detector";
import { findPoolWithToken, involvedMints, borrowCap } from "../utils";
import { logger } from "../../../utils/logger";

// Liquidation hunter. Skips when PoolMonitor is attached — LiquidationReactor
// handles liquidation detection event-driven in that case.
export function makeDetectLiquidations(deps: EngineDeps) {
  return async (state: GraphStateType): Promise<Partial<GraphStateType>> => {
    logger.debug({ node: "detect_liquidations" }, "graph: detect_liquidations");

    if (state.userConfig.liquidations === false) return {};

    // Fast path: liqEntry pre-populated filteredOpportunities — skip scan.
    if (state.filteredOpportunities.length > 0) return {};

    // signals_timer path: use poolMonitor live states when available.
    // Prefer on-chain positions when LendingClient is attached; otherwise
    // fall back to the legacy Redis registry.
    if (deps.lendingClient) {
      const tokenInfoByMint: Record<string, { name: string; decimals: number }> = {};
      for (const entry of Object.values(deps.tokens) as any[]) {
        if (entry.mint) tokenInfoByMint[entry.mint] = { name: entry.name, decimals: entry.decimals ?? 0 };
      }
      await deps.liquidationHunter.loadFromChain(tokenInfoByMint);
    } else {
      await deps.liquidationHunter.loadFromRedis();
    }

    const priceMap: Record<string, number> = { fUSDC: 1.0 };
    const p1 = deps.poolMonitor?.isRunning()
      ? deps.poolMonitor.getState("pool1")
      : state.poolStates.get("pool1");
    const p3 = deps.poolMonitor?.isRunning()
      ? deps.poolMonitor.getState("pool3")
      : state.poolStates.get("pool3");
    if (p1 && p1.reserveB > 0) priceMap[deps.tokens.tokenB.name] = p1.reserveA / p1.reserveB;
    if (p3 && p3.reserveB > 0) priceMap[deps.tokens.tokenC.name] = p3.reserveA / p3.reserveB;
    deps.liquidationHunter.applyPrices(priceMap);

    const liqs = deps.liquidationHunter.scan();
    if (liqs.length === 0) return {};

    const cap = borrowCap();
    const opps: DiscoveredOpportunity[] = [];

    for (const liq of liqs) {
      const poolForCollateral = findPoolWithToken(liq.collateralToken, state.validPools);
      if (!poolForCollateral) continue;

      const capital = Math.min(cap * 0.5, Math.max(10, liq.liquidationReward));
      const profitPct = liq.liquidationReward / Math.max(capital, 1) * 100;

      const liqOpp: ArbOpportunity = {
        type: "liquidation",
        path: `liquidation: ${liq.borrower.slice(0, 8)}… (${liq.collateralToken}/${liq.debtToken}) health=${liq.healthRatio.toFixed(3)}`,
        tokenIn: "fUSDC",
        tokenOut: liq.collateralToken,
        amountIn: capital,
        expectedProfit: liq.liquidationReward,
        profitPercent: parseFloat(profitPct.toFixed(2)),
        pools: [poolForCollateral.state],
        timestamp: Date.now(),
      };

      // Attach on-chain identity so execute_liq can find the position PDA.
      if (liq.positionPda && liq.collateralMint && liq.debtMint) {
        (liqOpp as any).liqMeta = {
          positionPda: liq.positionPda,
          collateralMint: liq.collateralMint,
          debtMint: liq.debtMint,
          collateralAmount: liq.collateralAmount,
          debtAmount: liq.debtAmount,
        };
      }

      opps.push({
        arb: liqOpp,
        poolStates: [poolForCollateral.state],
        involvedMints: involvedMints(poolForCollateral.pool, deps.tokens, deps.baseMint),
        poolKeys: [poolForCollateral.key],
        isTriangular: false,
      });
    }

    logger.debug({ found: opps.length }, "detect_liquidations done");
    return { opportunities: opps };
  };
}
