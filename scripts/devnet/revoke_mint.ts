import { Connection, PublicKey } from "@solana/web3.js";
import { setAuthority, AuthorityType } from "@solana/spl-token";
import { loadWallet } from "../../src/utils/wallet";
import { logger } from "../../src/utils/logger";
import fs from "fs";

async function revokeMint() {
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const wallet = loadWallet();
  const tokens = JSON.parse(fs.readFileSync("config/devnet_tokens.json", "utf-8"));

  for (const [key, token] of Object.entries(tokens) as [string, any][]) {
    try {
      await setAuthority(connection, wallet, new PublicKey(token.mint), wallet, AuthorityType.MintTokens, null);
      logger.info(`${token.name} mint authority revoked`);
    } catch (e: any) {
      const isAlreadyRevoked =
        e.message?.includes("already revoked") ||
        e.message?.includes("total supply of this token is fixed") ||
        e.transactionLogs?.some((l: string) =>
          l.includes("total supply of this token is fixed") || l.includes("custom program error: 0x5")
        );
      if (isAlreadyRevoked) {
        logger.info(`${token.name} mint authority already revoked — skipping`);
      } else {
        throw e;
      }
    }

    try {
      await setAuthority(connection, wallet, new PublicKey(token.mint), wallet, AuthorityType.FreezeAccount, null);
      logger.info(`${token.name} freeze authority revoked`);
    } catch {
      logger.info(`${token.name} has no freeze authority — skipping`);
    }
  }

  logger.info("=== All clean token mint + freeze authorities revoked ===");
}

revokeMint().catch(console.error);