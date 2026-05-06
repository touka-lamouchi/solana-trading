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
import { WhaleTracker } from "./layer1_opportunity/whale_tracker";
import { WhaleCache } from "./cache/whale_cache";
import { MainnetRPC } from "./infrastructure/mainnet_rpc";
import { VaultReader } from "./vault/vault_reader";
import { PoolMonitor } from "./infrastructure/pool_monitor";

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

  // 8b. Attach per-user vault reader (single-user mode = dev wallet is both owner and bot)
  if (config.vault?.program_id) {
    try {
      const baseTokenName = config.vault.base_mint ?? "fUSDC";
      const baseTokenEntry = Object.values(tokens).find(
        (t: any) => t.name === baseTokenName,
      ) as any;
      if (!baseTokenEntry) {
        throw new Error(`Base token ${baseTokenName} not found in devnet_tokens.json`);
      }
      const { PublicKey } = await import("@solana/web3.js");
      const vaultReader = new VaultReader({
        connection,
        signerForReads: wallet,
        userPubkey: wallet.publicKey,
        baseMint: new PublicKey(baseTokenEntry.mint),
      });
      protection.attachVaultReader(vaultReader);
      const initial = await vaultReader.getState();
      logger.info({
        exists: initial.exists,
        balance: initial.balance,
        active: initial.isActive,
      }, "Vault attached");
    } catch (e: any) {
      logger.warn({ error: e.message }, "VaultReader init failed — running without vault gating");
    }
  } else {
    logger.info("No vault.program_id in settings.yaml — vault gating disabled");
  }

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
    userKeypair: wallet,
  });

  // 10. Init ingestion service (loads feature columns from AI server)
  await engine.initIngestion();

  // 10b. Attach event-driven pool monitor — subscribes to all vault accounts
  // so arb and liquidation detection fires immediately on any price change.
  const poolMonitor = new PoolMonitor({ connection, pools, tokens });
  engine.attachPoolMonitor(poolMonitor);
  logger.info("PoolMonitor attached — event-driven arb/liquidation active");

  // 10b. Start whale tracker (separate 60s loop)
  let whaleTracker: WhaleTracker | null = null;
  if (config.whale_tracking?.enabled) {
    const whaleCache = new WhaleCache(cache);
    const mainnetMode = config.ai?.data_source === "mainnet";
    const whaleConnection = mainnetMode ? new MainnetRPC().getConnection() : connection;
    const trackedMints = mainnetMode && config.ai?.target_mint_mainnet
      ? [config.ai.target_mint_mainnet]
      : [tokens.tokenA.mint, tokens.tokenB.mint, tokens.tokenC.mint];
    whaleTracker = new WhaleTracker(whaleConnection, whaleCache, trackedMints, {
      scanIntervalMs: config.whale_tracking.scan_interval_ms,
      minWhaleBalancePct: config.whale_tracking.min_whale_balance_pct,
      accumulationThresholdPct: config.whale_tracking.accumulation_threshold_pct,
      distributionThresholdPct: config.whale_tracking.distribution_threshold_pct,
    });
    whaleTracker.startLoop();
  }

  // 11. Graceful shutdown
  process.on("SIGINT", () => { whaleTracker?.stop(); engine.stop(); poolMonitor.stop(); process.exit(0); });
  process.on("SIGTERM", () => { whaleTracker?.stop(); engine.stop(); poolMonitor.stop(); process.exit(0); });

  // 12. Start the engine loop (10s interval)
  logger.info("=== Bot started — running tick loop ===");
  await engine.startLoop(10_000);
}

boot().catch((err) => {
  logger.error({ err }, "Boot failed");
  process.exit(1);
});
