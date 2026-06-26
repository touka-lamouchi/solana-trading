/**
 * src/protection/ — Core protection logic (pure business rules, no Solana deps)
 *
 *   AutoPause      — consecutive-failure counter + pause flag
 *   Drawdown       — daily capital spending tracker
 *   SlippageGuard  — minimum-output calculator
 *   TradingHours   — time-window enforcer
 *   ProtectionManager — orchestrates all four in canExecuteTrade()
 *
 * src/layer3_protection/ wraps these with Solana-specific behavior:
 *   Layer3AutoPause    — cancels pending slow-path txs when pause fires
 *   Layer3Drawdown     — emits EventEmitter events on daily-limit hit
 *   HardSlippageLimits — simulates real txs on-chain before submission
 *   JitoMevProtection  — bundles txs via Jito block engine
 *   TxSubmitter        — runs canExecuteTrade() then signs & sends on-chain
 */
import { AutoPause, AutoPauseConfig } from "./auto_pause";
import { Drawdown, DrawdownConfig } from "./drawdown";
import { SlippageGuard, SlippageConfig } from "./slippage_guard";
import { TradingHours, TradingHoursConfig } from "./trading_hours";
import { VaultReader } from "../vault/vault_reader";
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
  private vaultReader: VaultReader | null = null;

  constructor(config: ProtectionConfig) {
    this.autoPause = new AutoPause(config.autoPause);
    this.drawdown = new Drawdown(config.drawdown);
    this.slippage = new SlippageGuard(config.slippage);
    this.tradingHours = new TradingHours(config.tradingHours);
    logger.info("Protection manager initialized");
  }

  attachVaultReader(reader: VaultReader): void {
    this.vaultReader = reader;
    logger.info("VaultReader attached to ProtectionManager");
  }

  getVaultReader(): VaultReader | null {
    return this.vaultReader;
  }

  // Returns the capital the bot is actually allowed to deploy for this trade.
  // Respects: drawdown remaining, per-trade cap, vault balance, vault active flag.
  // Returns 0 when the vault is paused or empty — caller should skip the trade.
  async getEffectiveCapital(maxPerTrade: number): Promise<{ capital: number; reason?: string }> {
    const drawdownStatus = this.drawdown.getStatus();
    const drawdownRemaining = drawdownStatus.remaining;

    let cap = Math.min(maxPerTrade, drawdownRemaining);
    if (cap <= 0) return { capital: 0, reason: "daily drawdown exhausted" };

    if (this.vaultReader) {
      try {
        const vs = await this.vaultReader.getState();
        if (!vs.exists) return { capital: 0, reason: "vault not created" };
        if (!vs.isActive) return { capital: 0, reason: "vault paused by owner" };
        cap = Math.min(cap, vs.balance);
        if (cap <= 0) return { capital: 0, reason: "vault empty" };
      } catch (e: any) {
        logger.warn({ error: e.message }, "VaultReader read failed — falling back to drawdown cap");
      }
    }

    return { capital: cap };
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

  // Runtime config updates
  updateDrawdownLimit(limit: number): void {
    this.drawdown.updateLimit(limit);
  }

  updateTradingHours(startTime: string, endTime: string): void {
    const toMinutes = (t: string) => {
      const [h, m] = t.split(":").map(Number);
      return (h ?? 0) * 60 + (m ?? 0);
    };
    const startMinutes = toMinutes(startTime);
    const endMinutes = toMinutes(endTime);
    const enabled = startMinutes !== endMinutes;
    this.tradingHours.update({ enabled, startMinutes, endMinutes });
  }
}