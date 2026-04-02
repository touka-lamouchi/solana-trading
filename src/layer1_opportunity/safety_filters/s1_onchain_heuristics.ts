import { Connection, PublicKey } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
import { logger } from "../../utils/logger";
import { getConfig } from "../../utils/config";

export interface S1Result {
  passed: boolean;
  token: string;
  checks: {
    mintAuthorityRevoked: boolean;
    freezeAuthorityRevoked: boolean;
    devWalletPercent: number;
    devWalletSafe: boolean;
  };
  failReason?: string;
}

export class OnChainHeuristics {
  private connection: Connection;
  private maxDevWalletPercent: number;

  constructor(connection: Connection, maxDevWalletPercent?: number) {
    this.connection = connection;
    this.maxDevWalletPercent = maxDevWalletPercent ?? getConfig().safety.max_dev_wallet_pct;
  }

  async check(mintAddress: string): Promise<S1Result> {
    const mintPubkey = new PublicKey(mintAddress);

    try {
      const mintInfo = await getMint(this.connection, mintPubkey);

      // Check 1: Mint authority should be revoked (null)
      const mintAuthorityRevoked = mintInfo.mintAuthority === null;

      // Check 2: Freeze authority should be revoked (null)
      const freezeAuthorityRevoked = mintInfo.freezeAuthority === null;

      // Check 3: Get largest token holders to check dev wallet concentration
      const largestAccounts = await this.connection.getTokenLargestAccounts(mintPubkey);
      const totalSupply = Number(mintInfo.supply);

      let devWalletPercent = 0;
      if (largestAccounts.value.length > 0 && totalSupply > 0) {
        const largest = largestAccounts.value[0];
        if (largest) {
          const largestBalance = Number(largest.amount);
          devWalletPercent = (largestBalance / totalSupply) * 100;
        }
      }

      const devWalletSafe = devWalletPercent <= this.maxDevWalletPercent;

      // Determine pass/fail
      let passed = true;
      let failReason: string | undefined = undefined;

      if (!mintAuthorityRevoked) {
        passed = false;
        failReason = "Mint authority still active — can mint unlimited tokens";
      } else if (!freezeAuthorityRevoked) {
        passed = false;
        failReason = "Freeze authority active — can freeze your tokens";
      } else if (!devWalletSafe) {
        passed = false;
        failReason = `Dev wallet holds ${devWalletPercent.toFixed(1)}% of supply (max ${this.maxDevWalletPercent}%)`;
      }

      const result: S1Result = {
        passed,
        token: mintAddress,
        checks: {
          mintAuthorityRevoked,
          freezeAuthorityRevoked,
          devWalletPercent,
          devWalletSafe,
        },
        ...(failReason !== undefined && { failReason }),
      };

      if (passed) {
        logger.info({ token: mintAddress.slice(0, 8) + "..." }, "S1 PASSED");
      } else {
        logger.warn({ token: mintAddress.slice(0, 8) + "...", reason: failReason }, "S1 FAILED");
      }

      return result;
    } catch (error) {
      logger.error({ token: mintAddress, error }, "S1 ERROR — treating as failed");
      return {
        passed: false,
        token: mintAddress,
        checks: {
          mintAuthorityRevoked: false,
          freezeAuthorityRevoked: false,
          devWalletPercent: 100,
          devWalletSafe: false,
        },
        failReason: "Failed to fetch token data",
      };
    }
  }
}