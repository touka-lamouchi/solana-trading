import { Transaction } from "@solana/web3.js";
import { ProtectionManager } from "../protection/protection_manager";
import { TransactionBuilder } from "../layer2_execution/transaction_builder";
import { logger } from "../utils/logger";
import { explorerTxUrl } from "../utils/config";

export class TxSubmitter {
  private txBuilder: TransactionBuilder;
  private protection: ProtectionManager;

  constructor(txBuilder: TransactionBuilder, protection: ProtectionManager) {
    this.txBuilder = txBuilder;
    this.protection = protection;
  }

  async submit(
    transaction: Transaction,
    capitalRequired: number,
    pathType: "fast" | "slow"
  ): Promise<{ success: boolean; signature?: string; reason?: string }> {
    const checkAmount = pathType === "fast" ? 0 : capitalRequired;
    const preCheck = this.protection.canExecuteTrade(checkAmount);

    if (!preCheck.allowed) {
      logger.warn({ reason: preCheck.reason }, "Trade BLOCKED by protection");
      return { success: false, reason: preCheck.reason ?? "blocked" };
    }

    try {
      const signature = await this.txBuilder.signAndSend(transaction);
      this.protection.recordResult(true);

      logger.info({
        signature,
        pathType,
        explorer: explorerTxUrl(signature),
      }, "Trade EXECUTED successfully");

      return { success: true, signature };
    } catch (error: any) {
      this.protection.recordResult(false);
      logger.error({ error: error.message, pathType }, "Trade FAILED");
      return { success: false, reason: error.message };
    }
  }
}