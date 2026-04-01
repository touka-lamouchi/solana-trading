import { logger } from "../utils/logger";

export interface DrawdownConfig {
  dailyLimit: number;
  autoPausePercent: number;  // pause at this % of daily limit (e.g. 90)
}

export class Drawdown {
  private dailyLimit: number;
  private spentToday: number = 0;
  private lastResetDay: number;
  private isPaused: boolean = false;
  private autoPausePercent: number;

  constructor(config: DrawdownConfig) {
    this.dailyLimit = config.dailyLimit;
    this.autoPausePercent = config.autoPausePercent;
    this.lastResetDay = this.getCurrentDay();
    logger.info({ dailyLimit: this.dailyLimit, autoPause: this.autoPausePercent + "%" }, "Drawdown initialized");
  }

  private getCurrentDay(): number {
    return Math.floor(Date.now() / 86400000);
  }

  private checkDayReset(): void {
    const today = this.getCurrentDay();
    if (today > this.lastResetDay) {
      this.spentToday = 0;
      this.lastResetDay = today;
      this.isPaused = false;
      logger.info("New day — drawdown counter reset");
    }
  }

  requestCapital(amount: number): boolean {
    this.checkDayReset();

    if (this.isPaused) {
      logger.warn({ amount }, "Capital request BLOCKED — drawdown paused");
      return false;
    }

    const newTotal = this.spentToday + amount;

    if (newTotal > this.dailyLimit) {
      logger.warn({
        requested: amount,
        spent: this.spentToday,
        limit: this.dailyLimit,
      }, "Capital request BLOCKED — exceeds daily limit");
      return false;
    }

    this.spentToday = newTotal;

    const usedPercent = (this.spentToday / this.dailyLimit) * 100;
    if (usedPercent >= this.autoPausePercent) {
      this.isPaused = true;
      logger.warn({ usedPercent: usedPercent.toFixed(1) }, "Drawdown auto-paused");
    }

    logger.info({
      approved: amount,
      totalToday: this.spentToday,
      limit: this.dailyLimit,
      remaining: this.dailyLimit - this.spentToday,
    }, "Capital approved");

    return true;
  }

  updateLimit(newLimit: number): void {
    this.dailyLimit = newLimit;
    logger.info({ newLimit }, "Daily limit updated");
  }

  getStatus() {
    this.checkDayReset();
    return {
      dailyLimit: this.dailyLimit,
      spentToday: this.spentToday,
      remaining: this.dailyLimit - this.spentToday,
      isPaused: this.isPaused,
      usedPercent: ((this.spentToday / this.dailyLimit) * 100).toFixed(1) + "%",
    };
  }
}