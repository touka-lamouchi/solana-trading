import { logger } from "../utils/logger";

export interface TradingHoursConfig {
  enabled: boolean;
  startMinutes: number;  // 0-1439 local time
  endMinutes: number;    // 0-1439 local time
}

export class TradingHours {
  private enabled: boolean;
  private startMinutes: number;
  private endMinutes: number;

  constructor(config: TradingHoursConfig) {
    this.enabled = config.enabled;
    this.startMinutes = config.startMinutes;
    this.endMinutes = config.endMinutes;
    if (this.enabled) {
      logger.info({ start: this.startMinutes, end: this.endMinutes }, "Trading hours enabled");
    } else {
      logger.info("Trading hours: 24/7 mode");
    }
  }

  canTrade(): boolean {
    if (!this.enabled) return true;

    const now = new Date();
    const current = now.getHours() * 60 + now.getMinutes();

    if (this.startMinutes < this.endMinutes) {
      const allowed = current >= this.startMinutes && current < this.endMinutes;
      if (!allowed) {
        logger.warn({ current, allowed: `${this.startMinutes}-${this.endMinutes}` }, "Outside trading hours");
      }
      return allowed;
    } else {
      // Overnight range e.g. 22:00-08:00
      const allowed = current >= this.startMinutes || current < this.endMinutes;
      if (!allowed) {
        logger.warn({ current, allowed: `${this.startMinutes}-${this.endMinutes}` }, "Outside trading hours");
      }
      return allowed;
    }
  }

  update(config: Partial<TradingHoursConfig>): void {
    if (config.enabled !== undefined) this.enabled = config.enabled;
    if (config.startMinutes !== undefined) this.startMinutes = config.startMinutes;
    if (config.endMinutes !== undefined) this.endMinutes = config.endMinutes;
    logger.info({ enabled: this.enabled, start: this.startMinutes, end: this.endMinutes }, "Trading hours updated");
  }
}