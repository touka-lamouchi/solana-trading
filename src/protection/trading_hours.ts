import { logger } from "../utils/logger";

export interface TradingHoursConfig {
  enabled: boolean;
  startHour: number;  // 0-23 UTC
  endHour: number;    // 0-23 UTC
}

export class TradingHours {
  private enabled: boolean;
  private startHour: number;
  private endHour: number;

  constructor(config: TradingHoursConfig) {
    this.enabled = config.enabled;
    this.startHour = config.startHour;
    this.endHour = config.endHour;
    if (this.enabled) {
      logger.info({ start: this.startHour, end: this.endHour }, "Trading hours enabled");
    } else {
      logger.info("Trading hours: 24/7 mode");
    }
  }

  canTrade(): boolean {
    if (!this.enabled) return true;

    const hour = new Date().getUTCHours();

    if (this.startHour < this.endHour) {
      // Normal range: e.g. 8-22
      const allowed = hour >= this.startHour && hour < this.endHour;
      if (!allowed) {
        logger.warn({ currentHour: hour, allowed: `${this.startHour}-${this.endHour}` }, "Outside trading hours");
      }
      return allowed;
    } else {
      // Overnight range: e.g. 22-8
      const allowed = hour >= this.startHour || hour < this.endHour;
      if (!allowed) {
        logger.warn({ currentHour: hour, allowed: `${this.startHour}-${this.endHour}` }, "Outside trading hours");
      }
      return allowed;
    }
  }

  update(config: Partial<TradingHoursConfig>): void {
    if (config.enabled !== undefined) this.enabled = config.enabled;
    if (config.startHour !== undefined) this.startHour = config.startHour;
    if (config.endHour !== undefined) this.endHour = config.endHour;
    logger.info({ enabled: this.enabled, start: this.startHour, end: this.endHour }, "Trading hours updated");
  }
}