import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { Connection, Keypair } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import fs from "fs";

import { UserRegistry } from "./user_registry";
import { CacheManager } from "../cache/cache_manager";
import { TradingEngine, MarketSnapshot, TickResult } from "../engine/trading_engine";
import { ProtectionManager } from "../protection/protection_manager";
import { ModelServer } from "../models/model_server";
import { loadWallet } from "../utils/wallet";
import { getConfig } from "../utils/config";
import { logger } from "../utils/logger";
import { issueNonce, verifyAndIssueToken, isValidPubkey, verifyToken } from "./auth/siws";
import { makeAuthenticate, makeRequireOwner } from "./middleware/auth";
import { validateBody } from "./middleware/validate";
import { ConfigUpdateSchema, TestSlowOppSchema } from "./schemas";
import { auditLog } from "./audit";

const PORT = parseInt(process.env["API_PORT"] ?? "3001");

async function boot() {
  logger.info("=== Solana Trading Bot API Server — Starting ===");

  const config = getConfig();

  // 1. Connect to Solana
  const connection = new Connection(config.network.rpc_url, {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 60000,
  });
  const { blockhash } = await connection.getLatestBlockhash();
  logger.info({ blockhash }, "Solana connected");

  // 2. Redis
  const cache = new CacheManager();
  const redisPong = await cache.ping();
  logger.info({ connected: redisPong }, "Redis status");
  if (!redisPong) {
    logger.error("Redis is not running! Start it with: redis-server");
    process.exit(1);
  }

  // 3. AI server check
  const aiServer = new ModelServer();
  const aiAlive = await aiServer.healthCheck();
  logger.info({ alive: aiAlive }, "AI Server status");

  // 4. Load programs (using bot's own wallet as provider)
  const botWallet = loadWallet();
  const provider = new AnchorProvider(connection, new Wallet(botWallet), {
    commitment: "confirmed",
  });
  const ammIdl = JSON.parse(
    fs.readFileSync("programs-amm/target/idl/programs_amm.json", "utf-8")
  );
  const flashIdl = JSON.parse(
    fs.readFileSync("programs-protection/target/idl/programs_protection.json", "utf-8")
  );
  const ammProgram = new Program(ammIdl, provider) as any;
  const flashProgram = new Program(flashIdl, provider) as any;

  // 5. Load pool/token configs
  const pools = JSON.parse(fs.readFileSync("config/devnet_pools.json", "utf-8"));
  const tokens = JSON.parse(fs.readFileSync("config/devnet_tokens.json", "utf-8"));
  const dirtyTokens = JSON.parse(fs.readFileSync("config/devnet_dirty_tokens.json", "utf-8"));

  // 6. Create user registry
  const registry = new UserRegistry({
    connection,
    cache,
    ammProgram,
    flashProgram,
    pools,
    tokens,
    dirtyTokens,
  });

  // 7. Shared viewer engine — scans pools for everyone, no wallet needed
  const viewerProtection = new ProtectionManager({
    autoPause: { maxConsecutiveFailures: 999 },
    drawdown: { dailyLimit: 0, autoPausePercent: 100 },
    slippage: { maxSlippageBps: config.protection.slippage_max_bps },
    tradingHours: { enabled: false, startHour: 0, endHour: 23 },
  });

  const viewerEngine = new TradingEngine({
    connection,
    ammProgram,
    flashProgram,
    pools,
    tokens,
    dirtyTokens,
    cache,
    protection: viewerProtection,
    userKeypair: botWallet, // read-only — viewer never executes
  });
  viewerEngine.setUserConfig({ mode: "viewer" });

  // Viewer doesn't run startLoop, but we still want the news feed flowing
  // so the /news endpoint has fresh data for browse-mode users.
  viewerEngine.startNewsFeed();

  // Run viewer tick loop in the background
  let lastViewerTick: TickResult | null = null;
  let lastViewerMarket: MarketSnapshot | null = null;
  const viewerListeners: ((data: any) => void)[] = [];

  const viewerLoop = async () => {
    logger.info("Viewer engine started (shared market scanner)");
    while (true) {
      try {
        const result = await viewerEngine.tick();
        lastViewerTick = result;
        if (result.market) lastViewerMarket = result.market;

        // Broadcast to all viewer WebSocket subscribers
        for (const detail of result.details) {
          const event = {
            type: "opportunity_found",
            pool: detail.pool,
            pair: detail.opportunity,
            profit: detail.profit,
            reason: detail.reason,
            timestamp: Date.now(),
          };
          for (const listener of viewerListeners) {
            try { listener(event); } catch { /* ignore */ }
          }
        }

        const reactor = viewerEngine.consumeReactorCounters();
        const scanEvent = {
          type: "scan_complete",
          poolsScanned: result.poolsScanned,
          opportunitiesFound: result.opportunitiesFound + reactor.opportunities,
          poolEvents: reactor.poolEvents,
          market: result.market ?? null,
          timestamp: Date.now(),
        };
        for (const listener of viewerListeners) {
          try { listener(scanEvent); } catch { /* ignore */ }
        }
      } catch (e: any) {
        logger.error({ error: e.message }, "Viewer tick failed");
      }
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
  };
  viewerLoop(); // fire and forget

  // ── Express app ─────────────────────────────────────────

  const authCfg = config.auth ?? { enabled: false };
  const authEnabled = authCfg.enabled === true;
  const adminPubkeys = authCfg.admin_pubkeys ?? [];
  const authOpts = { enabled: authEnabled };
  const authenticate = makeAuthenticate(authOpts);
  const requireOwner = makeRequireOwner(authOpts);

  if (!authEnabled) {
    logger.warn(
      "auth.enabled is FALSE — running in DEVNET BYPASS mode. " +
        "No authentication or ownership checks. Do NOT use in production."
    );
  }

  const app = express();
  app.set("trust proxy", 1); // behind a reverse proxy / TLS terminator in prod

  // A05 — security headers
  app.use(helmet());

  // A05 — CORS: open in devnet bypass, locked to an allowlist when auth is on.
  if (authEnabled) {
    const origins = authCfg.cors_origins ?? [];
    app.use(cors({ origin: origins, credentials: true }));
  } else {
    app.use(cors());
  }

  app.use(express.json({ limit: "64kb" })); // bound payload size

  // A05 — rate limiting
  const rl = authCfg.rate_limit ?? { window_ms: 60000, max_requests: 120, auth_max_requests: 10 };
  const generalLimiter = rateLimit({
    windowMs: rl.window_ms,
    max: rl.max_requests,
    standardHeaders: true,
    legacyHeaders: false,
  });
  const strictLimiter = rateLimit({
    windowMs: rl.window_ms,
    max: rl.auth_max_requests,
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use(generalLimiter);

  // ── Auth routes (SIWS + JWT) ────────────────────────────
  // GET /auth/nonce?pubkey=<base58> → message to sign
  app.get("/auth/nonce", strictLimiter, async (req, res) => {
    const pubkey = (req.query["pubkey"] as string) ?? "";
    if (!isValidPubkey(pubkey)) {
      res.status(400).json({ error: "Invalid pubkey" });
      return;
    }
    const { message } = await issueNonce(cache, pubkey);
    res.json({ message });
  });

  // POST /auth/verify { pubkey, signature } → { token }
  app.post("/auth/verify", strictLimiter, async (req, res) => {
    const { pubkey, signature } = req.body ?? {};
    if (!isValidPubkey(pubkey) || typeof signature !== "string") {
      res.status(400).json({ error: "pubkey and signature required" });
      return;
    }
    const token = await verifyAndIssueToken(cache, pubkey, signature, adminPubkeys);
    if (!token) {
      auditLog("auth_failed", { pubkey });
      res.status(401).json({ error: "Signature verification failed" });
      return;
    }
    auditLog("auth_success", { pubkey });
    res.json({ token });
  });

  // Health
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      activeUsers: registry.getActiveUserCount(),
      aiServer: aiAlive,
      redis: redisPong,
    });
  });

  // Market data (no auth needed — viewer mode)
  app.get("/market", (_req, res) => {
    const decision = viewerEngine.getLastDecision();
    res.json({
      market: lastViewerMarket,
      aiConfidence: decision?.aiScore ?? null,
      aiDirection: decision?.direction ?? null,
      sentiment: decision?.sentimentLabel ?? null,
      regime: decision?.regime ?? null,
      volatility: decision?.regime === "crash" ? "high"
                : decision?.regime === "trending" ? "normal"
                : decision?.regime === "ranging" ? "low"
                : null,
      whaleActivity: decision?.whaleDirection === "bullish" ? "Accumulating"
                   : decision?.whaleDirection === "bearish" ? "Distributing"
                   : decision?.whaleDirection === "neutral" ? "Holding"
                   : null,
      lastScan: lastViewerTick ? {
        poolsScanned: lastViewerTick.poolsScanned,
        opportunitiesFound: lastViewerTick.opportunitiesFound,
      } : null,
      timestamp: Date.now(),
    });
  });

  // News + Insights (viewer mode — no auth needed)
  // Returns latest cached crypto + geopolitics headlines and the viewer
  // engine's last AI decision so the frontend can show "what we saw and
  // what we decided".
  app.get("/news", async (_req, res) => {
    try {
      const symbol = (config.ai?.target_symbol ?? "SOL").toLowerCase();
      const redis = cache.getClient();
      const [cryptoRaw, geoRaw] = await Promise.all([
        redis.get(`news:crypto:${symbol}`),
        redis.get("news:geopolitics:global"),
      ]);
      const parse = (s: string | null) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
      const decision = viewerEngine.getLastDecision();
      res.json({
        symbol,
        crypto: parse(cryptoRaw),
        geopolitics: parse(geoRaw),
        decision: decision ? {
          aiScore: decision.aiScore,
          direction: decision.direction,
          regime: decision.regime,
          newsDirection: decision.newsDirection,
          newsCombined: decision.newsCombined,
          newsHeadlineCount: decision.newsHeadlineCount,
          breakdown: decision.breakdown,
          sentimentLabel: decision.sentimentLabel,
          whaleDirection: decision.whaleDirection,
          mempoolDirection: decision.mempoolDirection,
        } : null,
        timestamp: Date.now(),
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Start bot for a user
  app.post("/users/:userId/start", strictLimiter, authenticate, requireOwner, async (req, res) => {
    const userId = String(req.params["userId"]);

    try {
      if (registry.isRunning(userId)) {
        res.status(400).json({ error: "User already running" });
        return;
      }

      // For devnet: use the bot's wallet for all users
      // For mainnet: load per-user wallet or derive from vault
      const walletKeypair = botWallet;

      await registry.startUser(userId, walletKeypair);
      auditLog("bot_started", { userId, by: req.auth?.sub });
      res.json({ status: "started", userId });
    } catch (e: any) {
      logger.error({ userId, error: e.message }, "Failed to start user");
      res.status(500).json({ error: e.message });
    }
  });

  // Stop bot for a user
  app.post("/users/:userId/stop", strictLimiter, authenticate, requireOwner, async (req, res) => {
    const userId = String(req.params["userId"]);

    try {
      await registry.stopUser(userId);
      auditLog("bot_stopped", { userId, by: req.auth?.sub });
      res.json({ status: "stopped", userId });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  // Get user status
  app.get("/users/:userId/status", authenticate, requireOwner, (req, res) => {
    const userId = String(req.params["userId"]);
    const status = registry.getStatus(userId);

    if (!status) {
      res.json({ userId, running: false, lastTick: null });
      return;
    }

    res.json(status);
  });

  // Get trade history
  app.get("/users/:userId/trades", authenticate, requireOwner, async (req, res) => {
    const userId = String(req.params["userId"]);
    const date = req.query.date as string | undefined;
    const trades = await registry.getTrades(userId, date);
    res.json(trades);
  });

  // Get/update user config
  app.get("/users/:userId/config", authenticate, requireOwner, async (req, res) => {
    const userId = String(req.params["userId"]);
    const config = await registry.getConfig(userId);
    res.json(config);
  });

  app.post(
    "/users/:userId/config",
    authenticate,
    requireOwner,
    validateBody(ConfigUpdateSchema),
    async (req, res) => {
      const userId = String(req.params["userId"]);
      const updated = await registry.updateConfig(userId, req.body);
      auditLog("config_changed", { userId, by: req.auth?.sub, fields: Object.keys(req.body) });
      res.json(updated);
    }
  );

  // Test the slow-path safety + protection chain against an arbitrary mint.
  // Body: { mint: string, amountIn?: number }
  // Emits a safety_rejected / guard_rejected / trade_rejected WS event so the
  // frontend activity log shows exactly which Sx blocked the trade.
  app.post(
    "/users/:userId/test-slow-opportunity",
    strictLimiter,
    authenticate,
    requireOwner,
    validateBody(TestSlowOppSchema),
    async (req, res) => {
    const userId = String(req.params["userId"]);
    const { mint, amountIn } = req.body ?? {};
    try {
      const detail = await registry.testSlowOpportunity(userId, mint, { amountIn });
      if (!detail) {
        res.status(404).json({ error: "user not running" });
        return;
      }
      auditLog("test_opportunity", { userId, by: req.auth?.sub, mint });
      res.json({ stage: detail.stage, reason: detail.reason, reasonCode: detail.reasonCode });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // List active users
  app.get("/users", (_req, res) => {
    res.json({
      activeUsers: registry.getActiveUserIds(),
      count: registry.getActiveUserCount(),
    });
  });

  // ── HTTP + WebSocket server ─────────────────────────────

  const server = http.createServer(app);

  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws: WebSocket) => {
    let subscribedUserId: string | null = null;
    let tickListener: ((result: any) => void) | null = null;
    let marketListener: ((data: any) => void) | null = null;

    ws.on("message", (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());

        // Subscribe to market feed (no wallet needed)
        if (msg.type === "subscribe_market") {
          marketListener = (data: any) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "tick", userId: "__viewer__", data }));
            }
          };
          viewerListeners.push(marketListener);
          ws.send(JSON.stringify({ type: "subscribed_market" }));
        }

        // Subscribe to a user's tick feed
        if (msg.type === "subscribe" && msg.userId) {
          // Auth: when enabled, the subscriber must present a JWT whose subject
          // matches the userId they want to stream (WS equivalent of requireOwner).
          if (authEnabled) {
            const payload = msg.token ? verifyToken(msg.token) : null;
            if (!payload || (payload.role !== "admin" && payload.sub !== msg.userId)) {
              ws.send(JSON.stringify({ type: "error", message: "Unauthorized" }));
              return;
            }
          }

          // Unsubscribe from previous
          if (subscribedUserId && tickListener) {
            registry.removeTickListener(subscribedUserId, tickListener);
          }

          subscribedUserId = msg.userId;
          tickListener = (result) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "tick", userId: subscribedUserId, data: result }));
            }
          };
          registry.onTick(subscribedUserId!, tickListener);

          ws.send(JSON.stringify({ type: "subscribed", userId: subscribedUserId }));
        }

        // Get status
        if (msg.type === "status" && msg.userId) {
          const status = registry.getStatus(msg.userId);
          ws.send(JSON.stringify({ type: "status", data: status }));
        }
      } catch {
        ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      }
    });

    ws.on("close", () => {
      if (subscribedUserId && tickListener) {
        registry.removeTickListener(subscribedUserId, tickListener);
      }
      if (marketListener) {
        const idx = viewerListeners.indexOf(marketListener);
        if (idx >= 0) viewerListeners.splice(idx, 1);
      }
    });
  });

  // ── Start server ────────────────────────────────────────

  server.listen(PORT, () => {
    logger.info({ port: PORT }, "API server started");
    logger.info(`  REST:      http://localhost:${PORT}`);
    logger.info(`  WebSocket: ws://localhost:${PORT}/ws`);
    logger.info(`  Health:    http://localhost:${PORT}/health`);
  });

  // ── Graceful shutdown ───────────────────────────────────

  const shutdown = async () => {
    logger.info("Shutting down...");
    await registry.stopAll();
    server.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

boot().catch((err) => {
  logger.error({ err }, "API server boot failed");
  process.exit(1);
});
