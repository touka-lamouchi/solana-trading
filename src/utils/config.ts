import fs from "fs";
import path from "path";
import yaml from "js-yaml";

export interface AppConfig {
  network: {
    rpc_url: string;
    ws_url: string;
    cluster: string;
    explorer_url: string;
  };
  redis: { host: string; port: number };
  ai_server: { host: string; port: number };
  capital: {
    daily_limit_usd: number;
    max_per_trade_usd: number;
    flash_loan_max_usd: number;
  };
  trading_hours: {
    enabled: boolean;
    start_utc: string;
    end_utc: string;
  };
  protection: {
    max_consecutive_failures: number;
    drawdown_pause_pct: number;
    slippage_max_bps: number;
  };
  fees: {
    base_priority_fee_microlamports: number;
    max_fee_pct_of_profit: number;
    compute_units_per_hop: number;
    flash_loan_compute_units: number;
  };
  amm: {
    fee_numerator: number;
    fee_denominator: number;
  };
  jito: {
    block_engine_url: string;
    tip_lamports: number;
    max_poll_attempts: number;
    poll_interval_ms: number;
  };
  sandwich_detection: {
    min_suspicious_lamports: number;
  };
  safety: {
    isolation_forest_threshold: number;
    max_dev_wallet_pct: number;
    min_unique_holders: number;
    wash_trading_top2_threshold: number;
  };
}

export interface StrategyConfig {
  strategies: {
    crypto_arbitrage: { enabled: boolean; min_profit_usd: number; min_profit_pct: number };
    crypto_liquidation: { enabled: boolean; min_reward_usd: number };
    crypto_yield_farming: { enabled: boolean; min_apy_diff_pct: number; max_capital_usd: number };
    momentum_trade: { enabled: boolean; min_lstm_confidence: number; max_capital_usd: number };
    sentiment_trade: { enabled: boolean; min_sentiment_score: number; max_capital_usd: number };
    [key: string]: any;
  };
}

let _settings: AppConfig | null = null;
let _strategies: StrategyConfig | null = null;

function loadYaml<T>(filePath: string): T {
  const abs = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);
  return yaml.load(fs.readFileSync(abs, "utf-8")) as T;
}

export function getConfig(): AppConfig {
  if (!_settings) {
    _settings = loadYaml<AppConfig>("config/settings.yaml");
  }
  return _settings;
}

export function getStrategyConfig(): StrategyConfig {
  if (!_strategies) {
    _strategies = loadYaml<StrategyConfig>("config/strategy_params.yaml");
  }
  return _strategies;
}

// Convenience: explorer tx URL, cluster-aware
export function explorerTxUrl(signature: string): string {
  const cfg = getConfig();
  const cluster = cfg.network.cluster;
  const base = cfg.network.explorer_url;
  if (cluster === "mainnet-beta") return `${base}/tx/${signature}`;
  return `${base}/tx/${signature}?cluster=${cluster}`;
}
