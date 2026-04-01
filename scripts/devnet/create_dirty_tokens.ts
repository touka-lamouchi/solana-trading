import { Connection } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { loadWallet } from "../../src/utils/wallet";
import { logger } from "../../src/utils/logger";
import fs from "fs";

async function createDirtyTokens() {
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const wallet = loadWallet();

  logger.info("Creating dirty/suspicious tokens for safety filter testing...");

  const dirtyMint1 = await createMint(
    connection, wallet, wallet.publicKey, wallet.publicKey, 6
  );
  logger.info({ mint: dirtyMint1.toBase58() }, "Dirty Token 1: mint + freeze authority active");

  const dirtyMint2 = await createMint(
    connection, wallet, wallet.publicKey, null, 6
  );
  const dirtyAccount2 = await getOrCreateAssociatedTokenAccount(
    connection, wallet, dirtyMint2, wallet.publicKey
  );
  await mintTo(connection, wallet, dirtyMint2, dirtyAccount2.address, wallet, 900_000 * 10 ** 6);
  logger.info({ mint: dirtyMint2.toBase58() }, "Dirty Token 2: 90% dev wallet allocation");

  const cleanMint = await createMint(
    connection, wallet, wallet.publicKey, null, 6
  );
  const cleanAccount = await getOrCreateAssociatedTokenAccount(
    connection, wallet, cleanMint, wallet.publicKey
  );
  await mintTo(connection, wallet, cleanMint, cleanAccount.address, wallet, 100_000 * 10 ** 6);
  logger.info({ mint: cleanMint.toBase58() }, "Clean Token: normal characteristics");

  const dirtyConfig = {
    dirty1_mint_authority: {
      mint: dirtyMint1.toBase58(),
      issue: "Mint and freeze authority still active",
    },
    dirty2_dev_heavy: {
      mint: dirtyMint2.toBase58(),
      account: dirtyAccount2.address.toBase58(),
      issue: "90% supply in dev wallet",
    },
    clean: {
      mint: cleanMint.toBase58(),
      account: cleanAccount.address.toBase58(),
      note: "Normal token for comparison",
    },
  };

  fs.writeFileSync(
    "config/devnet_dirty_tokens.json",
    JSON.stringify(dirtyConfig, null, 2)
  );

  logger.info("Dirty token config saved to config/devnet_dirty_tokens.json");
  logger.info("=== Dirty tokens created ===");
}

createDirtyTokens().catch(console.error);