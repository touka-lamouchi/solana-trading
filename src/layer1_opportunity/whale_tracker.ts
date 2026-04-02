import { Connection, PublicKey } from "@solana/web3.js";
import { WhaleCache, WhaleState } from "../cache/whale_cache";
import { getConfig } from "../utils/config";
import { logger } from "../utils/logger";

export interface WhaleTrackerConfig {
  scanIntervalMs: number;
  minWhaleBalancePct: number;
  accumulationThresholdPct: number;
  distributionThresholdPct: number;
}

interface WalletSnapshot {
  address: string;
  balance: number;
}

export class WhaleTracker {
  private connection: Connection;
  private whaleCache: WhaleCache;
  private tokenMints: string[];
  private config: WhaleTrackerConfig;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  // In-memory state: previous balance snapshots per token
  private previousSnapshots = new Map<string, Map<string, number>>();
  // Consecutive action tracker per wallet
  private consecutiveActions = new Map<string, { action: string; count: number }>();

  constructor(
    connection: Connection,
    whaleCache: WhaleCache,
    tokenMints: string[],
    config?: Partial<WhaleTrackerConfig>,
  ) {
    this.connection = connection;
    this.whaleCache = whaleCache;
    this.tokenMints = tokenMints;

    const cfg = getConfig();
    this.config = {
      scanIntervalMs: config?.scanIntervalMs ?? cfg.whale_tracking?.scan_interval_ms ?? 60000,
      minWhaleBalancePct: config?.minWhaleBalancePct ?? cfg.whale_tracking?.min_whale_balance_pct ?? 5,
      accumulationThresholdPct: config?.accumulationThresholdPct ?? cfg.whale_tracking?.accumulation_threshold_pct ?? 5,
      distributionThresholdPct: config?.distributionThresholdPct ?? cfg.whale_tracking?.distribution_threshold_pct ?? 5,
    };

    logger.info({
      tokens: tokenMints.length,
      intervalMs: this.config.scanIntervalMs,
      minBalancePct: this.config.minWhaleBalancePct,
    }, "Whale tracker initialized");
  }

  // ── Scan all tracked tokens ────────────────────────────

  async scanAll(): Promise<void> {
    for (const mint of this.tokenMints) {
      try {
        await this.scanToken(mint);
      } catch (e: any) {
        logger.warn({ mint: mint.slice(0, 8) + "...", error: e.message }, "Whale scan failed for token");
      }
    }
  }

  // ── Scan a single token ────────────────────────────────

  async scanToken(mint: string): Promise<void> {
    const mintPubkey = new PublicKey(mint);
    const largestAccounts = await this.connection.getTokenLargestAccounts(mintPubkey);

    if (largestAccounts.value.length === 0) return;

    // Calculate total supply from largest accounts
    const totalSupply = largestAccounts.value.reduce(
      (sum, a) => sum + Number(a.amount), 0,
    );
    if (totalSupply === 0) return;

    // Get previous snapshot for this token
    const prevSnap = this.previousSnapshots.get(mint) ?? new Map<string, number>();
    const currentSnap = new Map<string, number>();

    for (const account of largestAccounts.value) {
      const address = account.address.toBase58();
      const balance = parseFloat(account.uiAmount?.toString() ?? "0");
      const balanceRaw = Number(account.amount);

      // Only track wallets holding >= minWhaleBalancePct of supply
      const holdingPct = (balanceRaw / totalSupply) * 100;
      if (holdingPct < this.config.minWhaleBalancePct) continue;

      currentSnap.set(address, balance);

      // Classify action based on balance change
      const previousBalance = prevSnap.get(address);
      const action = this.classifyAction(balance, previousBalance);
      const confidence = this.calculateConfidence(balance, previousBalance, address, action);

      // Write to cache
      const state: WhaleState = {
        wallet: address,
        action,
        token: mint,
        amount: balance,
        confidence,
        updatedAt: Date.now(),
      };

      await this.whaleCache.set(address, state);
    }

    // Check for wallets that disappeared (fully exited)
    for (const [address, prevBalance] of prevSnap) {
      if (!currentSnap.has(address) && prevBalance > 0) {
        const state: WhaleState = {
          wallet: address,
          action: "distributing",
          token: mint,
          amount: 0,
          confidence: 0.9,
          updatedAt: Date.now(),
        };
        await this.whaleCache.set(address, state);

        logger.info({
          wallet: address.slice(0, 8) + "...",
          token: mint.slice(0, 8) + "...",
          previousBalance: prevBalance.toFixed(2),
        }, "Whale fully exited position");
      }
    }

    // Save current snapshot for next comparison
    this.previousSnapshots.set(mint, currentSnap);

    const whaleCount = currentSnap.size;
    if (whaleCount > 0) {
      logger.info({
        token: mint.slice(0, 8) + "...",
        whales: whaleCount,
        totalSupply: (totalSupply / 1e6).toFixed(2) + "M",
      }, "Whale scan complete");
    }
  }

  // ── Classify wallet action from balance delta ──────────

  private classifyAction(
    currentBalance: number,
    previousBalance: number | undefined,
  ): WhaleState["action"] {
    // First observation — no previous data
    if (previousBalance === undefined) return "unknown";

    // Fully exited
    if (currentBalance === 0 && previousBalance > 0) return "distributing";

    // New position
    if (previousBalance === 0 && currentBalance > 0) return "accumulating";

    // Calculate percentage change
    const deltaPct = ((currentBalance - previousBalance) / previousBalance) * 100;

    if (deltaPct > this.config.accumulationThresholdPct) return "accumulating";
    if (deltaPct < -this.config.distributionThresholdPct) return "distributing";
    return "holding";
  }

  // ── Calculate confidence score ─────────────────────────

  private calculateConfidence(
    currentBalance: number,
    previousBalance: number | undefined,
    walletAddress: string,
    action: WhaleState["action"],
  ): number {
    if (action === "unknown") return 0;
    if (action === "holding") return 0.9;

    // Base confidence from magnitude of change
    let baseConfidence = 0.5;
    if (previousBalance !== undefined && previousBalance > 0) {
      const deltaPct = Math.abs(((currentBalance - previousBalance) / previousBalance) * 100);
      baseConfidence = Math.min(deltaPct / 20, 1.0);
    }

    // Consecutive action bonus
    const prev = this.consecutiveActions.get(walletAddress);
    let consecutiveBonus = 0;
    if (prev && prev.action === action) {
      prev.count++;
      consecutiveBonus = Math.min(prev.count * 0.1, 0.3);
    } else {
      this.consecutiveActions.set(walletAddress, { action, count: 1 });
    }

    return Math.min(baseConfidence + consecutiveBonus, 1.0);
  }

  // ── Loop control ───────────────────────────────────────

  startLoop(): void {
    this.running = true;
    logger.info({ intervalMs: this.config.scanIntervalMs }, "Whale tracker loop started");

    const run = async () => {
      if (!this.running) return;
      try {
        await this.scanAll();
      } catch (e: any) {
        logger.error({ error: e.message }, "Whale tracker scan error");
      }
      if (this.running) {
        this.timer = setTimeout(run, this.config.scanIntervalMs);
      }
    };

    // First scan immediately
    run();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logger.info("Whale tracker stopped");
  }
}
