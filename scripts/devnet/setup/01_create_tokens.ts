import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { loadWallet } from "../../../src/utils/wallet";
import { logger } from "../../../src/utils/logger";
import fs from "fs";

async function createTokens() {
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const wallet = loadWallet();

  logger.info("Creating test tokens on devnet...");

  // Create Token A (fake USDC)
  const tokenAMint = await createMint(
    connection,
    wallet,           // payer
    wallet.publicKey,  // mint authority
    null,              // freeze authority
    6                  // decimals (like USDC)
  );
  logger.info({ mint: tokenAMint.toBase58() }, "Token A (fUSDC) created");

  // Create Token B (fake SOL wrapper)
  const tokenBMint = await createMint(
    connection,
    wallet,
    wallet.publicKey,
    null,
    9                  // decimals (like SOL)
  );
  logger.info({ mint: tokenBMint.toBase58() }, "Token B (fSOL) created");

  // Create Token C (fake RAY)
  const tokenCMint = await createMint(
    connection,
    wallet,
    wallet.publicKey,
    null,
    6
  );
  logger.info({ mint: tokenCMint.toBase58() }, "Token C (fRAY) created");

  // Create token accounts for our wallet
  const tokenAAccount = await getOrCreateAssociatedTokenAccount(
    connection, wallet, tokenAMint, wallet.publicKey
  );
  const tokenBAccount = await getOrCreateAssociatedTokenAccount(
    connection, wallet, tokenBMint, wallet.publicKey
  );
  const tokenCAccount = await getOrCreateAssociatedTokenAccount(
    connection, wallet, tokenCMint, wallet.publicKey
  );

  // Mint tokens to our wallet
  const MILLION = 1_000_000;

  await mintTo(connection, wallet, tokenAMint, tokenAAccount.address, wallet, MILLION * 10 ** 6);
  logger.info("Minted 1,000,000 fUSDC");

  await mintTo(connection, wallet, tokenBMint, tokenBAccount.address, wallet, MILLION * 10 ** 9);
  logger.info("Minted 1,000,000 fSOL");

  await mintTo(connection, wallet, tokenCMint, tokenCAccount.address, wallet, MILLION * 10 ** 6);
  logger.info("Minted 1,000,000 fRAY");

  // Save token info to config
  const tokenConfig = {
    tokenA: {
      name: "fUSDC",
      mint: tokenAMint.toBase58(),
      decimals: 6,
      account: tokenAAccount.address.toBase58(),
    },
    tokenB: {
      name: "fSOL",
      mint: tokenBMint.toBase58(),
      decimals: 9,
      account: tokenBAccount.address.toBase58(),
    },
    tokenC: {
      name: "fRAY",
      mint: tokenCMint.toBase58(),
      decimals: 6,
      account: tokenCAccount.address.toBase58(),
    },
  };

  fs.writeFileSync(
    "config/devnet_tokens.json",
    JSON.stringify(tokenConfig, null, 2)
  );

  logger.info("Token config saved to config/devnet_tokens.json");
  logger.info("=== All tokens created successfully ===");
}

createTokens().catch(console.error);