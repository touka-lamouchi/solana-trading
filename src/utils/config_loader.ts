import yaml from "js-yaml";
import fs from "fs";
import path from "path";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface NetworkConfig {
  rpc_url: string;
  ws_url: string;
  cluster: "devnet" | "mainnet-beta";
}

export interface RedisConfig {
  host: string;
  port: number;
}

export interface AiServerConfig {
  host: string;
  port: number;
}

export interface DatabaseConfig {
  name: string;
  host: string;
  port: number;
}

export interface CapitalConfig {
  daily_limit_usd: number;
  max_per_trade_usd: number;
  flash_loan_max_usd: number;
}

export interface TradingHoursConfig {
  enabled: boolean;
  start_utc: string;
  end_utc: string;
}

export interface ApprovalConfig {
  fast_path: "auto" | "manual";
  slow_path: "auto" | "manual";
}

export interface ProtectionConfig {
  max_consecutive_failures: number;
  drawdown_pause_pct: number;
  slippage_max_bps: number;
}

export interface BotConfig {
  network: NetworkConfig;
  redis: RedisConfig;
  ai_server: AiServerConfig;
  database: DatabaseConfig;
  capital: CapitalConfig;
  trading_hours: TradingHoursConfig;
  approval: ApprovalConfig;
  protection: ProtectionConfig;
}

export interface StrategyParams {
  enabled: boolean;
  min_profit_usd?: number;
  min_profit_pct?: number;
  min_reward_usd?: number;
  min_deviation_pct?: number;
  min_apy_diff_pct?: number;
  min_lstm_confidence?: number;
  min_sentiment_score?: number;
  max_capital_usd?: number;
}

export interface StrategyConfig {
  strategies: Record<string, StrategyParams>;
}

// ── Loader ────────────────────────────────────────────────────────────────────

let _cache: { bot: BotConfig; strategies: StrategyConfig } | null = null;

export function loadConfig(): { bot: BotConfig; strategies: StrategyConfig } {
  if (_cache) return _cache;

  const settingsPath = path.resolve("config/settings.yaml");
  const strategyPath = path.resolve("config/strategy_params.yaml");

  const bot = yaml.load(fs.readFileSync(settingsPath, "utf-8")) as BotConfig;
  const strategies = yaml.load(fs.readFileSync(strategyPath, "utf-8")) as StrategyConfig;

  _cache = { bot, strategies };
  return _cache;
}

export function isStrategyEnabled(strategyKey: string): boolean {
  const { strategies } = loadConfig();
  return strategies.strategies[strategyKey]?.enabled ?? false;
}

export function getStrategyParams(strategyKey: string): StrategyParams | null {
  const { strategies } = loadConfig();
  return strategies.strategies[strategyKey] ?? null;
}

export function isWithinTradingHours(): boolean {
  const { bot } = loadConfig();
  if (!bot.trading_hours.enabled) return true;

  const now = new Date();
  const [startH, startM] = bot.trading_hours.start_utc.split(":").map(Number);
  const [endH, endM] = bot.trading_hours.end_utc.split(":").map(Number);

  const nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  return nowMinutes >= startMinutes && nowMinutes < endMinutes;
}
