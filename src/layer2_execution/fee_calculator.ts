import { Connection } from "@solana/web3.js";
import { getConfig } from "../utils/config";
import { logger } from "../utils/logger";

export class FeeCalculator {
  private connection: Connection;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  async calculatePriorityFee(estimatedProfit: number): Promise<number> {
    const cfg = getConfig();
    const baseFee = cfg.fees.base_priority_fee_microlamports;
    const maxFeePct = cfg.fees.max_fee_pct_of_profit;

    let recentFees: number[] = [];
    try {
      const fees = await this.connection.getRecentPrioritizationFees();
      recentFees = fees.map((f) => f.prioritizationFee).filter((f) => f > 0);
    } catch {
      recentFees = [];
    }

    let priorityFee = baseFee;
    if (recentFees.length > 0) {
      recentFees.sort((a, b) => a - b);
      priorityFee = recentFees[Math.floor(recentFees.length / 2)]!;
    }

    const profitLamports = estimatedProfit * 1e9;
    const maxFee = Math.floor(profitLamports * maxFeePct);

    if (priorityFee > maxFee && maxFee > 0) {
      priorityFee = maxFee;
    }

    if (priorityFee < baseFee) {
      priorityFee = baseFee;
    }

    logger.info({ priorityFee, estimatedProfit }, "Priority fee calculated");
    return priorityFee;
  }
}
