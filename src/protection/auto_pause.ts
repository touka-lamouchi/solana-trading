import { logger } from "../utils/logger";

export interface AutoPauseConfig {
  maxConsecutiveFailures: number;
}

export class AutoPause {
  private consecutiveFailures: number = 0;
  private isPaused: boolean = false;
  private totalTrades: number = 0;
  private totalFailures: number = 0;
  private maxConsecutiveFailures: number;

  constructor(config: AutoPauseConfig) {
    this.maxConsecutiveFailures = config.maxConsecutiveFailures;
    logger.info({ maxFailures: this.maxConsecutiveFailures }, "Auto-pause initialized");
  }

  recordTrade(success: boolean): void {
    this.totalTrades++;

    if (success) {
      this.consecutiveFailures = 0;
      logger.info({ trade: this.totalTrades }, "Trade succeeded, failure counter reset");
    } else {
      this.consecutiveFailures++;
      this.totalFailures++;
      logger.warn({
        trade: this.totalTrades,
        consecutive: this.consecutiveFailures,
        max: this.maxConsecutiveFailures,
      }, "Trade failed");

      if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
        this.isPaused = true;
        logger.error({ failures: this.consecutiveFailures }, "AUTO-PAUSE TRIGGERED");
      }
    }
  }

  canTrade(): boolean {
    if (this.isPaused) {
      logger.warn("Trade blocked — bot is paused");
      return false;
    }
    return true;
  }

  reset(): void {
    this.consecutiveFailures = 0;
    this.isPaused = false;
    logger.info("Auto-pause reset");
  }

  getStatus() {
    return {
      isPaused: this.isPaused,
      consecutiveFailures: this.consecutiveFailures,
      maxConsecutiveFailures: this.maxConsecutiveFailures,
      totalTrades: this.totalTrades,
      totalFailures: this.totalFailures,
    };
  }
}