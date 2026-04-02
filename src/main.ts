import { Connection } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import fs from "fs";

import { logger } from "./utils/logger";
import { CacheManager } from "./cache/cache_manager";
import { ModelServer } from "./models/model_server";
import { loadWallet } from "./utils/wallet";
import { getConfig, getStrategyConfig } from "./utils/config";
import { ProtectionManager } from "./protection/protection_manager";
import { TradingEngine } from "./engine/trading_engine";

async function boot() {
  logger.info("=== Solana Trading Bot — Starting ===");

  // 0. Load config
  const config = getConfig();
  const strategyConfig = getStrategyConfig();
  const enabledStrategies = Object.entries(strategyConfig.strategies)
    .filter(([, v]) => v.enabled)
    .map(([k]) => k);
  logger.info(
    { cluster: config.network.cluster, strategies: enabledStrategies },
    "Config loaded"
  );

  // 1. Load wallet
  const wallet = loadWallet();
  logger.info({ pubkey: wallet.publicKey.toBase58() }, "Wallet loaded");

  // 2. Connect to Solana
  const connection = new Connection(config.network.rpc_url, {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 60000,
  });
  const { blockhash } = await connection.getLatestBlockhash();
  logger.info({ blockhash }, "Solana connected");

  // 3. Check wallet balance
  const balance = await connection.getBalance(wallet.publicKey);
  logger.info({ balance: balance / LAMPORTS_PER_SOL }, "Wallet balance (SOL)");

  // 4. Connect to Redis
  const cache = new CacheManager();
  const redisPong = await cache.ping();
  logger.info({ connected: redisPong }, "Redis status");

  if (!redisPong) {
    logger.error("Redis is not running! Start it with: redis-server");
    process.exit(1);
  }

  // 5. Check AI server
  const aiServer = new ModelServer();
  const aiAlive = await aiServer.healthCheck();
  logger.info({ alive: aiAlive }, "AI Server status");

  if (!aiAlive) {
    logger.warn("AI Server is not running — slow path disabled");
  }

  // 6. Load programs
  const provider = new AnchorProvider(connection, new Wallet(wallet), { commitment: "confirmed" });
  const ammIdl = JSON.parse(fs.readFileSync("programs-amm/target/idl/programs_amm.json", "utf-8"));
  const flashIdl = JSON.parse(fs.readFileSync("programs-protection/target/idl/programs_protection.json", "utf-8"));
  const ammProgram = new Program(ammIdl, provider) as any;
  const flashProgram = new Program(flashIdl, provider) as any;

  // 7. Load configs
  const pools = JSON.parse(fs.readFileSync("config/devnet_pools.json", "utf-8"));
  const tokens = JSON.parse(fs.readFileSync("config/devnet_tokens.json", "utf-8"));
  const dirtyTokens = JSON.parse(fs.readFileSync("config/devnet_dirty_tokens.json", "utf-8"));

  // 8. Protection manager
  const protection = new ProtectionManager({
    autoPause: { maxConsecutiveFailures: config.protection.max_consecutive_failures },
    drawdown: {
      dailyLimit: config.capital.daily_limit_usd,
      autoPausePercent: config.protection.drawdown_pause_pct,
    },
    slippage: { maxSlippageBps: config.protection.slippage_max_bps },
    tradingHours: {
      enabled: config.trading_hours.enabled,
      startHour: parseInt(config.trading_hours.start_utc?.split(":")[0] ?? "0"),
      endHour: parseInt(config.trading_hours.end_utc?.split(":")[0] ?? "23"),
    },
  });

  // 9. Create trading engine
  const engine = new TradingEngine({
    connection,
    ammProgram,
    flashProgram,
    pools,
    tokens,
    dirtyTokens,
    cache,
    protection,
  });

  // 10. Graceful shutdown
  process.on("SIGINT", () => { engine.stop(); process.exit(0); });
  process.on("SIGTERM", () => { engine.stop(); process.exit(0); });

  // 11. Start the engine loop (10s interval)
  logger.info("=== Bot started — running tick loop ===");
  await engine.startLoop(10_000);
}

boot().catch((err) => {
  logger.error({ err }, "Boot failed");
  process.exit(1);
});
