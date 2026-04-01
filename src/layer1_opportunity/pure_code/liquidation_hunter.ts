import { logger } from "../../utils/logger";
import { getStrategyConfig } from "../../utils/config";

export interface LiquidationOpportunity {
  type: "liquidation";
  protocol: string;
  borrower: string;
  healthRatio: number;
  collateralToken: string;
  debtToken: string;
  collateralAmount: number;
  debtAmount: number;
  liquidationReward: number;
  timestamp: number;
}

export interface LoanPosition {
  borrower: string;
  collateralToken: string;
  debtToken: string;
  collateralAmount: number;
  debtAmount: number;
  collateralPrice: number;
  debtPrice: number;
  liquidationThreshold: number; // e.g. 0.8 means liquidate at 80% collateral ratio
}

export class LiquidationHunter {
  private minReward: number;
  private positions: LoanPosition[] = [];

  constructor(minReward?: number) {
    const cfg = getStrategyConfig();
    this.minReward = minReward ?? cfg.strategies.crypto_liquidation.min_reward_usd;
  }

  // Calculate health ratio: collateral value / debt value
  calculateHealthRatio(position: LoanPosition): number {
    const collateralValue = position.collateralAmount * position.collateralPrice;
    const debtValue = position.debtAmount * position.debtPrice;
    if (debtValue === 0) return Infinity;
    return collateralValue / debtValue;
  }

  // Load positions (in production, this reads from on-chain lending protocols)
  // For devnet, we simulate positions
  loadSimulatedPositions(positions: LoanPosition[]): void {
    this.positions = positions;
    logger.info({ count: positions.length }, "Loaded loan positions");
  }

  // Scan for liquidatable positions
  scan(): LiquidationOpportunity[] {
    const opportunities: LiquidationOpportunity[] = [];

    for (const position of this.positions) {
      const healthRatio = this.calculateHealthRatio(position);

      if (healthRatio < position.liquidationThreshold) {
        const collateralValue = position.collateralAmount * position.collateralPrice;
        const debtValue = position.debtAmount * position.debtPrice;
        const liquidationReward = collateralValue - debtValue;

        if (liquidationReward >= this.minReward) {
          const opp: LiquidationOpportunity = {
            type: "liquidation",
            protocol: "simulated-lending",
            borrower: position.borrower,
            healthRatio,
            collateralToken: position.collateralToken,
            debtToken: position.debtToken,
            collateralAmount: position.collateralAmount,
            debtAmount: position.debtAmount,
            liquidationReward,
            timestamp: Date.now(),
          };

          opportunities.push(opp);
          logger.info({
            borrower: position.borrower,
            healthRatio: healthRatio.toFixed(4),
            reward: liquidationReward.toFixed(2),
          }, "LIQUIDATION FOUND");
        }
      }
    }

    if (opportunities.length === 0) {
      logger.info("No liquidatable positions found");
    }

    return opportunities;
  }
}