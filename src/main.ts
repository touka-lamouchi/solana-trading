import { logger } from "./utils/logger";
import { SolanaRPC } from "./infrastructure/solana_rpc";
import { CacheManager } from "./cache/cache_manager";
import { ModelServer } from "./models/model_server";
import { loadWallet } from "./utils/wallet";
import { loadConfig } from "./utils/config_loader";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";

async function boot() {
  logger.info("=== Solana Trading Bot — Starting ===");

  // 0. Load config
  const { bot, strategies } = loadConfig();
  const enabledStrategies = Object.entries(strategies.strategies)
    .filter(([, v]) => v.enabled)
    .map(([k]) => k);
  logger.info(
    { cluster: bot.network.cluster, strategies: enabledStrategies },
    "Config loaded"
  );

  // 1. Load wallet
  const wallet = loadWallet();
  logger.info({ pubkey: wallet.publicKey.toBase58() }, "Wallet loaded");

  // 2. Connect to Solana DevNet
  const solana = new SolanaRPC();
  const blockhash = await solana.getLatestBlockhash();
  logger.info({ blockhash }, "Solana DevNet connected");

  // 3. Check wallet balance
  const balance = await solana.getConnection().getBalance(wallet.publicKey);
  logger.info({ balance: balance / LAMPORTS_PER_SOL }, "Wallet balance (SOL)");

  // 4. Connect to Redis
  const cache = new CacheManager();
  const redisPong = await cache.ping();
  logger.info({ connected: redisPong }, "Redis status");

  // 5. Check AI server
  const aiServer = new ModelServer();
  const aiAlive = await aiServer.healthCheck();
  logger.info({ alive: aiAlive }, "AI Server status");

  if (!redisPong) {
    logger.error("Redis is not running! Start it with: redis-server");
    process.exit(1);
  }

  if (!aiAlive) {
    logger.warn("AI Server is not running — continuing without it for now");
  }

  // 6. Subscribe to devnet slots
  await solana.subscribeToSlots();

  logger.info("=== Bot started successfully ===");
}

boot().catch((err) => {
  logger.error({ err }, "Boot failed");
  process.exit(1);
});
