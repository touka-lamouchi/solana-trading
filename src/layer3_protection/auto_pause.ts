import { AutoPause } from "../protection/auto_pause";
import { logger } from "../utils/logger";

export interface SlowPathTx {
  signature: string;
  description?: string;
}

export class Layer3AutoPause {
  private inner: AutoPause;
  private pendingSlowPathTxs: SlowPathTx[] = [];

  constructor(inner: AutoPause) {
    this.inner = inner;
  }

  recordTrade(success: boolean): void {
    const wasPaused = !this.inner.canTrade();
    this.inner.recordTrade(success);
    const isNowPaused = !this.inner.canTrade();

    if (!wasPaused && isNowPaused) {
      this.cancelPendingSlowPathTransactions();
    }
  }

  registerSlowPathTx(tx: SlowPathTx): void {
    this.pendingSlowPathTxs.push(tx);
    logger.info({ signature: tx.signature }, "Slow-path tx registered for cancellation tracking");
  }

  deregisterSlowPathTx(signature: string): void {
    this.pendingSlowPathTxs = this.pendingSlowPathTxs.filter(tx => tx.signature !== signature);
  }

  private cancelPendingSlowPathTransactions(): void {
    const count = this.pendingSlowPathTxs.length;
    if (count === 0) return;

    logger.error(
      { count, signatures: this.pendingSlowPathTxs.map(t => t.signature) },
      "AUTO-PAUSE triggered — abandoning pending slow-path transactions"
    );

    // Transactions expire after ~90s on Solana if not confirmed.
    // We clear the queue so the bot loop won't retry them.
    this.pendingSlowPathTxs = [];
  }

  canTrade(): boolean {
    return this.inner.canTrade();
  }

  isPaused(): boolean {
    return !this.inner.canTrade();
  }

  reset(): void {
    this.inner.reset();
    this.pendingSlowPathTxs = [];
  }

  getStatus() {
    return this.inner.getStatus();
  }
}
