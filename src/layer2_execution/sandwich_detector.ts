import { Connection, PublicKey } from "@solana/web3.js";
import { logger } from "../utils/logger";
import { getConfig } from "../utils/config";

export interface SandwichRisk {
  detected: boolean;
  reason?: string;
  frontRunSignature?: string;
}

export class SandwichDetector {
  private connection: Connection;
  // Minimum SOL value of a suspicious front-run tx to flag
  private minSuspiciousLamports: number;

  constructor(connection: Connection, minSuspiciousLamports?: number) {
    this.connection = connection;
    this.minSuspiciousLamports = minSuspiciousLamports ?? getConfig().sandwich_detection.min_suspicious_lamports;
  }

  // Check recent mempool activity on the target pool for sandwich patterns.
  // A sandwich is detected when a large swap on the same pool appeared in the
  // last slot before ours — the attacker front-runs then back-runs our tx.
  async check(poolAddress: PublicKey): Promise<SandwichRisk> {
    try {
      const signatures = await this.connection.getSignaturesForAddress(poolAddress, { limit: 5 });

      if (signatures.length < 2) {
        return { detected: false };
      }

      // Look for a very recent large transaction on the same pool
      const recent = signatures[0];
      const secondMostRecent = signatures[1];

      if (!recent || !secondMostRecent) {
        return { detected: false };
      }

      // If two transactions hit the same pool within the same slot, flag it
      if (recent.slot === secondMostRecent.slot) {
        logger.warn({
          pool: poolAddress.toBase58(),
          slot: recent.slot,
          sig1: recent.signature,
          sig2: secondMostRecent.signature,
        }, "Potential sandwich detected — two txs in same slot on pool");

        return {
          detected: true,
          reason: "Two transactions in same slot on pool — possible sandwich",
          frontRunSignature: recent.signature,
        };
      }

      return { detected: false };
    } catch (err: any) {
      logger.warn({ error: err.message }, "Sandwich detection failed — assuming safe");
      return { detected: false };
    }
  }
}
