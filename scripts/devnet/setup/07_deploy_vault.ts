/**
 * Deploy the vault program to devnet and create a test vault.
 *
 * Prerequisites:
 *   cd programs-vault && anchor build && anchor deploy
 *
 * This script:
 *   1. Creates a vault for the dev wallet
 *   2. Deposits some fUSDC into it
 *   3. Saves vault addresses to config/devnet_vault.json
 */

import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet, BN } from "@coral-xyz/anchor";
import {
  getAssociatedTokenAddress,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import fs from "fs";
import { loadWallet } from "../../../src/utils/wallet";
import { getConfig } from "../../../src/utils/config";
import { logger } from "../../../src/utils/logger";

async function main() {
  const config = getConfig();
  const wallet = loadWallet();

  logger.info({ pubkey: wallet.publicKey.toBase58() }, "Wallet loaded");

  const connection = new Connection(config.network.rpc_url, "confirmed");
  const provider = new AnchorProvider(connection, new Wallet(wallet), {
    commitment: "confirmed",
  });

  // Load the vault program IDL
  const idl = JSON.parse(
    fs.readFileSync("programs-vault/target/idl/programs_vault.json", "utf-8")
  );
  const vaultProgram = new Program(idl, provider) as any;

  logger.info({ programId: vaultProgram.programId.toBase58() }, "Vault program loaded");

  // 1. Derive the vault PDA
  const [vaultPda, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("user_vault"), wallet.publicKey.toBuffer()],
    vaultProgram.programId
  );

  logger.info({ vaultPda: vaultPda.toBase58(), bump }, "Vault PDA derived");

  // 2. Create the vault (bot = same wallet for devnet testing)
  try {
    await vaultProgram.methods
      .createVault(wallet.publicKey) // bot = dev wallet for testing
      .accounts({
        userVault: vaultPda,
        user: wallet.publicKey,
        systemProgram: new PublicKey("11111111111111111111111111111111"),
      })
      .rpc();
    logger.info("Vault created successfully");
  } catch (e: any) {
    if (e.message?.includes("already in use")) {
      logger.info("Vault already exists — skipping creation");
    } else {
      throw e;
    }
  }

  // 3. Create vault token account for fUSDC and deposit
  const tokens = JSON.parse(fs.readFileSync("config/devnet_tokens.json", "utf-8"));
  const fusdcMint = new PublicKey(tokens.tokenA.mint);

  // Get user's fUSDC ATA
  const userAta = await getAssociatedTokenAddress(fusdcMint, wallet.publicKey);

  // Get vault's fUSDC ATA (owned by vault PDA)
  const vaultAta = await getAssociatedTokenAddress(fusdcMint, vaultPda, true);

  logger.info({
    userAta: userAta.toBase58(),
    vaultAta: vaultAta.toBase58(),
    mint: fusdcMint.toBase58(),
  }, "Token accounts");

  // Deposit 1000 fUSDC into the vault
  const depositAmount = new BN(1000 * 10 ** tokens.tokenA.decimals);

  try {
    await vaultProgram.methods
      .deposit(depositAmount)
      .accounts({
        userVault: vaultPda,
        userToken: userAta,
        vaultToken: vaultAta,
        mint: fusdcMint,
        user: wallet.publicKey,
        owner: wallet.publicKey,
        tokenProgram: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
        associatedTokenProgram: new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
        systemProgram: new PublicKey("11111111111111111111111111111111"),
      })
      .rpc();
    logger.info({ amount: "1000 fUSDC" }, "Deposited into vault");
  } catch (e: any) {
    logger.error({ error: e.message }, "Deposit failed");
  }

  // 4. Save vault config
  const vaultConfig = {
    vaultPda: vaultPda.toBase58(),
    vaultAtaFusdc: vaultAta.toBase58(),
    owner: wallet.publicKey.toBase58(),
    bot: wallet.publicKey.toBase58(),
    bump,
    programId: vaultProgram.programId.toBase58(),
  };

  fs.writeFileSync("config/devnet_vault.json", JSON.stringify(vaultConfig, null, 2));
  logger.info(vaultConfig, "Vault config saved to config/devnet_vault.json");
}

main().catch((err) => {
  logger.error({ err }, "Deploy vault failed");
  process.exit(1);
});
