import { logger } from "../utils/logger";

export interface SlippageConfig {
  maxSlippageBps: number;  // basis points: 100 = 1%, 500 = 5%
}

export class SlippageGuard {
  private maxSlippageBps: number;

  constructor(config: SlippageConfig) {
    this.maxSlippageBps = config.maxSlippageBps;
    logger.info({ maxSlippage: (this.maxSlippageBps / 100) + "%" }, "Slippage guard initialized");
  }

  // Calculate minimum output for a given expected output
  calculateMinimumOutput(expectedOutput: number): number {
    return Math.floor(expectedOutput * (10000 - this.maxSlippageBps) / 10000);
  }

  // Check if actual output is acceptable
  check(actualOutput: number, minimumOutput: number): boolean {
    if (actualOutput < minimumOutput) {
      logger.warn({
        actual: actualOutput,
        minimum: minimumOutput,
        shortfall: minimumOutput - actualOutput,
      }, "Slippage check FAILED");
      return false;
    }

    logger.info({
      actual: actualOutput,
      minimum: minimumOutput,
    }, "Slippage check passed");
    return true;
  }

  updateMaxSlippage(newMaxBps: number): void {
    this.maxSlippageBps = newMaxBps;
    logger.info({ maxSlippage: (this.maxSlippageBps / 100) + "%" }, "Max slippage updated");
  }

  getMaxSlippageBps(): number {
    return this.maxSlippageBps;
  }
}