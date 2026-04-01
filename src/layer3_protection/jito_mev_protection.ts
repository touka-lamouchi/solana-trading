import { Connection, Transaction, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { logger } from "../utils/logger";
import { getConfig } from "../utils/config";

const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvB8eLBRUMyMNiNEKVUSFkXnZZHuSqtLDQ",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zcaozgtRBE",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];

export interface JitoConfig {
  blockEngineUrl?: string;
  tipLamports?: number;
  tipAccount?: PublicKey;
  maxPollAttempts?: number;
  pollIntervalMs?: number;
  dryRun?: boolean;        // set true for devnet testing
}

export interface BundleSubmissionResult {
  bundleId: string;
  status: "accepted" | "rejected" | "timeout" | "landed";
  error?: string;
}

export class JitoMevProtection {
  private connection: Connection;
  private payer: Keypair;
  private blockEngineUrl: string;
  private tipLamports: number;
  private tipAccount: PublicKey;
  private maxPollAttempts: number;
  private pollIntervalMs: number;
  private dryRun: boolean;

  constructor(connection: Connection, payer: Keypair, config: JitoConfig = {}) {
    this.connection = connection;
    this.payer = payer;
    const cfg = getConfig();
    this.blockEngineUrl = config.blockEngineUrl ?? cfg.jito.block_engine_url;
    this.tipLamports = config.tipLamports ?? cfg.jito.tip_lamports;
    this.tipAccount = config.tipAccount ?? JitoMevProtection.randomTipAccount();
    this.maxPollAttempts = config.maxPollAttempts ?? cfg.jito.max_poll_attempts;
    this.pollIntervalMs = config.pollIntervalMs ?? cfg.jito.poll_interval_ms;
    this.dryRun = config.dryRun ?? this.blockEngineUrl.includes("devnet");

    logger.info({
      blockEngineUrl: this.blockEngineUrl,
      tipLamports: this.tipLamports,
      tipAccount: this.tipAccount.toBase58(),
      dryRun: this.dryRun,
    }, "Jito MEV protection initialized");
  }

  async submitAsBundle(transaction: Transaction): Promise<BundleSubmissionResult> {
    return this.submitBundleAtomic([transaction]);
  }

  async submitBundleAtomic(transactions: Transaction[]): Promise<BundleSubmissionResult> {
    const { blockhash } = await this.connection.getLatestBlockhash();

    for (const tx of transactions) {
      if (!tx.recentBlockhash) tx.recentBlockhash = blockhash;
      if (!tx.feePayer) tx.feePayer = this.payer.publicKey;
      tx.sign(this.payer);
    }

    const tipTx = this.buildTipTransaction(blockhash);
    tipTx.sign(this.payer);

    // Bundle order: main txs first, tip last (Jito requirement)
    const bundle = [...transactions, tipTx];

    if (this.dryRun) {
      const mockId = `devnet-dry-run-${Date.now()}`;
      logger.info({ bundleId: mockId, txCount: bundle.length }, "Jito dry-run: bundle accepted (not submitted)");
      return { bundleId: mockId, status: "accepted" };
    }

    try {
      const serialized = this.serializeTransactions(bundle);
      const bundleId = await this.sendBundle(serialized);
      logger.info({ bundleId, txCount: bundle.length }, "Jito bundle submitted");
      return await this.pollBundleStatus(bundleId);
    } catch (err: any) {
      logger.error({ error: err.message }, "Jito bundle submission failed");
      return { bundleId: "", status: "rejected", error: err.message };
    }
  }

  private buildTipTransaction(recentBlockhash: string): Transaction {
    const tx = new Transaction();
    tx.recentBlockhash = recentBlockhash;
    tx.feePayer = this.payer.publicKey;
    tx.add(
      SystemProgram.transfer({
        fromPubkey: this.payer.publicKey,
        toPubkey: this.tipAccount,
        lamports: this.tipLamports,
      })
    );
    return tx;
  }

  private serializeTransactions(transactions: Transaction[]): string[] {
    const bs58 = require("bs58");
    return transactions.map(tx => bs58.encode(tx.serialize()));
  }

  private async sendBundle(serializedTxs: string[]): Promise<string> {
    const response = await fetch(`${this.blockEngineUrl}/api/v1/bundles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sendBundle",
        params: [serializedTxs],
      }),
    });

    const json = await response.json() as any;

    if (json.error) {
      throw new Error(`Jito API error: ${JSON.stringify(json.error)}`);
    }

    return json.result as string;
  }

  private async pollBundleStatus(bundleId: string): Promise<BundleSubmissionResult> {
    for (let i = 0; i < this.maxPollAttempts; i++) {
      await new Promise(r => setTimeout(r, this.pollIntervalMs));

      try {
        const response = await fetch(`${this.blockEngineUrl}/api/v1/bundles`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "getBundleStatuses",
            params: [[bundleId]],
          }),
        });

        const json = await response.json() as any;
        const statuses = json.result?.value;

        if (statuses && statuses.length > 0) {
          const s = statuses[0].confirmation_status;
          logger.info({ bundleId, status: s, attempt: i + 1 }, "Bundle status polled");

          if (s === "confirmed" || s === "finalized") {
            return { bundleId, status: "landed" };
          }
          if (s === "invalid") {
            return { bundleId, status: "rejected", error: "Bundle invalid/expired" };
          }
        }
      } catch {
        // polling error — keep trying
      }
    }

    logger.warn({ bundleId }, "Bundle status polling timed out");
    return { bundleId, status: "timeout" };
  }

  static randomTipAccount(): PublicKey {
    const idx = Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length);
    return new PublicKey(JITO_TIP_ACCOUNTS[idx]!);
  }
}
