import { Connection, PublicKey, Logs } from "@solana/web3.js";
import { CacheManager } from "../cache/cache_manager";
import { logger } from "../utils/logger";

/**
 * MempoolMonitor — listens to AMM swap events on Solana via WebSocket
 * logsSubscribe and aggregates per-mint buy/sell pressure in Redis.
 *
 * Solana has no traditional mempool; this listens to *recently confirmed*
 * txs (~400ms after they hit the leader). Good enough for momentum signals
 * on a 30s-2min horizon.
 *
 * Buy / sell classification: each AMM swap has a token-out side. If the
 * tracked mint is the token-out → buy. If token-in → sell. We approximate
 * the USD value from the SOL amount × Pyth-cached SOL/USD or fall back
 * to the raw amount for devnet where USD pricing is irrelevant.
 *
 * Devnet note: there's no real swap volume on devnet pools, so when no
 * data flows in we synthesize gentle drift so downstream code keeps
 * exercising the full path.
 */

export interface MempoolPressureResult {
  mint: string;
  buyTxCount: number;
  sellTxCount: number;
  buyVolume: number;        // raw token amount or USD (best effort)
  sellVolume: number;
  pressureScore: number;    // -1 (extreme sell) to +1 (extreme buy)
  updatedAt: number;
}

interface PressureWindow {
  buyTxCount: number;
  sellTxCount: number;
  buyVolume: number;
  sellVolume: number;
  windowStart: number;
}

const CACHE_TTL_SECONDS = 3;
const WINDOW_MS = 30_000;

// AMM program IDs we listen to. On devnet we use the project's own AMM;
// on mainnet swap these for Raydium V4 + Orca Whirlpool.
const DEVNET_AMM_FALLBACK = "11111111111111111111111111111111";

export class MempoolMonitor {
  private connection: Connection;
  private cache: CacheManager;
  private trackedMints: Set<string>;
  private programIds: PublicKey[];

  // In-memory rolling windows keyed by mint
  private windows = new Map<string, PressureWindow>();

  // Subscription IDs for cleanup
  private subscriptions: number[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(opts: {
    connection: Connection;
    cache: CacheManager;
    trackedMints: string[];
    programIds?: string[];
  }) {
    this.connection = opts.connection;
    this.cache = opts.cache;
    this.trackedMints = new Set(opts.trackedMints);
    this.programIds = (opts.programIds && opts.programIds.length > 0
      ? opts.programIds
      : [DEVNET_AMM_FALLBACK]
    ).map((id) => new PublicKey(id));
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    for (const pid of this.programIds) {
      try {
        const subId = this.connection.onLogs(
          pid,
          (logs, ctx) => this.handleLogs(pid, logs, ctx.slot),
          "confirmed",
        );
        this.subscriptions.push(subId);
        logger.info({ program: pid.toBase58() }, "MempoolMonitor: subscribed");
      } catch (e: any) {
        logger.warn({ error: e.message, program: pid.toBase58() },
          "MempoolMonitor: subscription failed");
      }
    }

    // Periodic flush — writes the current window to Redis and resets it
    this.flushTimer = setInterval(() => this.flushAll().catch(() => {}), 2000);
    logger.info({ mints: Array.from(this.trackedMints) },
      "MempoolMonitor started");
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    for (const subId of this.subscriptions) {
      try { await this.connection.removeOnLogsListener(subId); } catch { /* ignore */ }
    }
    this.subscriptions = [];

    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    logger.info("MempoolMonitor stopped");
  }

  // ── Log handler ──────────────────────────────────────────
  // Solana log entries from AMM programs encode swap details. We do a
  // best-effort classification: scan the log strings for "Swap"/"swap",
  // and pick a mint if it appears in the program data. For devnet logs
  // that don't include mint info we fall back to round-robin through the
  // tracked mints as synthetic activity.
  private handleLogs(_program: PublicKey, logs: Logs, _slot: number): void {
    if (logs.err) return;
    if (!logs.logs || logs.logs.length === 0) return;

    const text = logs.logs.join(" ").toLowerCase();
    const isSwap = text.includes("swap") || text.includes("ray_log") ||
                   text.includes("instruction: swap");
    if (!isSwap) return;

    for (const mint of this.trackedMints) {
      if (text.includes(mint.toLowerCase())) {
        // Direction: only count when we can read it directly from the log.
        // No random fallback — better to record nothing than fabricate flow.
        const explicitBuy = text.includes(`out:${mint.toLowerCase()}`)
                         || text.includes(`buy ${mint.toLowerCase()}`);
        const explicitSell = text.includes(`in:${mint.toLowerCase()}`)
                          || text.includes(`sell ${mint.toLowerCase()}`);
        if (!explicitBuy && !explicitSell) return;
        const volume = this.estimateVolumeFromLog(text);
        if (volume <= 0) return;
        this.recordSwap(mint, explicitBuy, volume);
        return;
      }
    }
  }

  // Parse volume from the log text. Only accepts real numeric amounts; if we
  // can't extract one, we return 0 (the caller skips the swap rather than
  // injecting a synthetic volume).
  private estimateVolumeFromLog(text: string): number {
    const match = text.match(/amount[: =]+(\d+(?:\.\d+)?)/i)
              || text.match(/lamports[: =]+(\d+)/i);
    if (!match) return 0;
    const v = parseFloat(match[1]!);
    return isFinite(v) && v > 0 ? v : 0;
  }

  private recordSwap(mint: string, isBuy: boolean, volume: number): void {
    const now = Date.now();
    let win = this.windows.get(mint);
    if (!win || now - win.windowStart > WINDOW_MS) {
      win = { buyTxCount: 0, sellTxCount: 0, buyVolume: 0, sellVolume: 0, windowStart: now };
      this.windows.set(mint, win);
    }
    if (isBuy) {
      win.buyTxCount++;
      win.buyVolume += volume;
    } else {
      win.sellTxCount++;
      win.sellVolume += volume;
    }
  }

  // ── Persistence ──────────────────────────────────────────
  private async flushAll(): Promise<void> {
    for (const mint of this.trackedMints) {
      const win = this.windows.get(mint);
      if (!win) continue;
      const result = this.windowToResult(mint, win);
      await this.writeCache(result).catch(() => {});
    }
  }

  private windowToResult(mint: string, win: PressureWindow): MempoolPressureResult {
    const totalVol = win.buyVolume + win.sellVolume;
    const totalTx = win.buyTxCount + win.sellTxCount;
    let pressureScore = 0;
    if (totalVol > 0) {
      pressureScore = (win.buyVolume - win.sellVolume) / totalVol;
    } else if (totalTx > 0) {
      pressureScore = (win.buyTxCount - win.sellTxCount) / totalTx;
    }
    pressureScore = Math.max(-1, Math.min(1, pressureScore));

    return {
      mint,
      buyTxCount: win.buyTxCount,
      sellTxCount: win.sellTxCount,
      buyVolume: parseFloat(win.buyVolume.toFixed(4)),
      sellVolume: parseFloat(win.sellVolume.toFixed(4)),
      pressureScore: parseFloat(pressureScore.toFixed(4)),
      updatedAt: Date.now(),
    };
  }

  private cacheKey(mint: string): string {
    return `mempool:${mint}`;
  }

  private async writeCache(result: MempoolPressureResult): Promise<void> {
    await this.cache.getClient().set(
      this.cacheKey(result.mint),
      JSON.stringify(result),
      "EX",
      CACHE_TTL_SECONDS,
    );
  }

  // ── Public API ───────────────────────────────────────────
  async getPressure(mint: string): Promise<MempoolPressureResult | null> {
    const raw = await this.cache.getClient().get(this.cacheKey(mint));
    if (raw) {
      try { return JSON.parse(raw) as MempoolPressureResult; } catch { /* ignore */ }
    }
    // Fall back to in-memory window if cache miss
    const win = this.windows.get(mint);
    if (!win) return null;
    return this.windowToResult(mint, win);
  }

  isTracking(mint: string): boolean {
    return this.trackedMints.has(mint);
  }

  getTrackedMints(): string[] {
    return Array.from(this.trackedMints);
  }
}
