import { Connection, PublicKey } from "@solana/web3.js";
import { logger } from "../../utils/logger";
import { getConfig } from "../../utils/config";

export interface S4Result {
  passed: boolean;
  token: string;
  checks: {
    washTradingDetected: boolean;
    suspiciousHolderCount: boolean;
  };
  failReason?: string;
}

export class AnomalyDetection {
  private connection: Connection;
  private minUniqueHolders: number;

  constructor(connection: Connection, minUniqueHolders?: number) {
    this.connection = connection;
    this.minUniqueHolders = minUniqueHolders ?? getConfig().safety.min_unique_holders;
  }

  async check(mintAddress: string): Promise<S4Result> {
    try {
      const mintPubkey = new PublicKey(mintAddress);

      // Check 1: Get token holders — too few holders is suspicious
      const largestAccounts = await this.connection.getTokenLargestAccounts(mintPubkey);
      const holderCount = largestAccounts.value.filter(
        (a) => Number(a.amount) > 0
      ).length;

      const suspiciousHolderCount = holderCount < this.minUniqueHolders;

      // Check 2: Wash trading detection
      // In production, this analyzes transaction history for patterns:
      // - Same wallet buying and selling repeatedly
      // - Circular transfers between a small set of wallets
      // - Suspiciously regular transaction timing
      // For devnet, we use holder distribution as a proxy
      const totalSupply = largestAccounts.value.reduce(
        (sum, a) => sum + Number(a.amount), 0
      );

      let washTradingDetected = false;

      if (totalSupply > 0 && largestAccounts.value.length >= 2) {
        const top2 = largestAccounts.value.slice(0, 2);
        const top2Percent = top2.reduce(
          (sum, a) => sum + Number(a.amount), 0
        ) / totalSupply;

        // If top 2 wallets hold above threshold it might be wash trading between them
        if (top2Percent > getConfig().safety.wash_trading_top2_threshold) {
          washTradingDetected = true;
        }
      }

      // Determine pass/fail
      let passed = true;
      let failReason: string | undefined;

      if (washTradingDetected) {
        passed = false;
        failReason = "Wash trading pattern detected — top 2 wallets hold >95%";
      } else if (suspiciousHolderCount) {
        passed = false;
        failReason = `Only ${holderCount} holders (minimum ${this.minUniqueHolders})`;
      }

      const result: S4Result = {
        passed,
        token: mintAddress,
        checks: {
          washTradingDetected,
          suspiciousHolderCount,
        },
        ...(failReason !== undefined && { failReason }),
      };

      if (passed) {
        logger.info({ token: mintAddress.slice(0, 8) + "...", holders: holderCount }, "S4 PASSED");
      } else {
        logger.warn({ token: mintAddress.slice(0, 8) + "...", reason: failReason }, "S4 FAILED");
      }

      return result;
    } catch (error) {
      logger.error({ token: mintAddress, error }, "S4 ERROR — treating as failed");
      return {
        passed: false,
        token: mintAddress,
        checks: {
          washTradingDetected: false,
          suspiciousHolderCount: true,
        },
        failReason: "Failed to analyze wallet graph",
      };
    }
  }
}