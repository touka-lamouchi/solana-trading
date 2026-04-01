import { AutoPause, AutoPauseConfig } from "./auto_pause";
import { Drawdown, DrawdownConfig } from "./drawdown";
import { SlippageGuard, SlippageConfig } from "./slippage_guard";
import { TradingHours, TradingHoursConfig } from "./trading_hours";
import { logger } from "../utils/logger";

export interface ProtectionConfig {
  autoPause: AutoPauseConfig;
  drawdown: DrawdownConfig;
  slippage: SlippageConfig;
  tradingHours: TradingHoursConfig;
}

export class ProtectionManager {
  public autoPause: AutoPause;
  public drawdown: Drawdown;
  public slippage: SlippageGuard;
  public tradingHours: TradingHours;

  constructor(config: ProtectionConfig) {
    this.autoPause = new AutoPause(config.autoPause);
    this.drawdown = new Drawdown(config.drawdown);
    this.slippage = new SlippageGuard(config.slippage);
    this.tradingHours = new TradingHours(config.tradingHours);
    logger.info("Protection manager initialized");
  }

  // Run all pre-trade checks
  canExecuteTrade(capitalRequired: number): { allowed: boolean; reason?: string } {
    // Check 1: Is the bot paused?
    if (!this.autoPause.canTrade()) {
      return { allowed: false, reason: "Bot paused — too many consecutive failures" };
    }

    // Check 2: Are we within trading hours?
    if (!this.tradingHours.canTrade()) {
      return { allowed: false, reason: "Outside configured trading hours" };
    }

    // Check 3: Do we have enough daily capital?
    if (capitalRequired > 0 && !this.drawdown.requestCapital(capitalRequired)) {
      return { allowed: false, reason: "Daily drawdown limit exceeded" };
    }

    return { allowed: true };
  }

  // Get minimum output for a swap
  getMinimumOutput(expectedOutput: number): number {
    return this.slippage.calculateMinimumOutput(expectedOutput);
  }

  // Record trade result
  recordResult(success: boolean): void {
    this.autoPause.recordTrade(success);
  }

  // Get full status
  getStatus() {
    return {
      autoPause: this.autoPause.getStatus(),
      drawdown: this.drawdown.getStatus(),
      maxSlippageBps: this.slippage.getMaxSlippageBps(),
    };
  }
}