import { EventEmitter } from "events";
import { Drawdown } from "../protection/drawdown";
import { logger } from "../utils/logger";

export const DAILY_LIMIT_HIT_EVENT = "dailyLimitHit";

export interface DrawdownLimitEvent {
  spentToday: number;
  dailyLimit: number;
  timestamp: Date;
  message: string;
}

export class Layer3Drawdown extends EventEmitter {
  private inner: Drawdown;
  private limitEmittedToday: boolean = false;

  constructor(inner: Drawdown) {
    super();
    this.inner = inner;
  }

  requestCapital(amount: number): boolean {
    const wasBlocked = this.inner.getStatus().isPaused;
    const allowed = this.inner.requestCapital(amount);

    if (!allowed && !this.limitEmittedToday) {
      this.limitEmittedToday = true;
      const status = this.inner.getStatus();
      const event: DrawdownLimitEvent = {
        spentToday: status.spentToday,
        dailyLimit: status.dailyLimit,
        timestamp: new Date(),
        message: "Daily drawdown limit hit — all trades blocked",
      };
      logger.error(event, "DAILY DRAWDOWN LIMIT HIT");
      this.emit(DAILY_LIMIT_HIT_EVENT, event);
    }

    return allowed;
  }

  isLimitHit(): boolean {
    return this.inner.getStatus().isPaused;
  }

  resetDailyWindow(): void {
    this.limitEmittedToday = false;
    logger.info("Layer3Drawdown daily window reset");
  }

  getStatus() {
    return this.inner.getStatus();
  }

  updateLimit(newLimit: number): void {
    this.inner.updateLimit(newLimit);
  }
}
