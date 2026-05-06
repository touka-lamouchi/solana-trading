import { Connection, PublicKey, SystemProgram, Keypair } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet, web3 } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID, createAccount, transfer } from "@solana/spl-token";
import { loadWallet } from "../../../src/utils/wallet";
import { logger } from "../../../src/utils/logger";
import fs from "fs";

const protectionIdl = JSON.parse(
  fs.readFileSync("programs-protection/target/idl/programs_protection.json", "utf-8")
);

async function setupFlashVault() {
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const wallet = loadWallet();
  const provider = new AnchorProvider(connection, new Wallet(wallet), { commitment: "confirmed" });

  const program = new Program(protectionIdl, provider) as any;
  const programId = program.programId;
  const tokens = JSON.parse(fs.readFileSync("config/devnet_tokens.json", "utf-8"));
  const mint = new PublicKey(tokens.tokenA.mint);

  logger.info("=== Setting up Flash Loan Vault ===");

  const [flashConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("flash_vault"), wallet.publicKey.toBuffer()],
    programId
  );
  logger.info({ flashConfigPda: flashConfigPda.toBase58() }, "Flash config PDA");

  // Check if already initialized
  const existing = await connection.getAccountInfo(flashConfigPda);

  const vaultKeypair = Keypair.generate();

  if (!existing) {
    // Fresh init
    await program.methods
      .initializeFlashVault()
      .accounts({
        flashConfig: flashConfigPda,
        vault: vaultKeypair.publicKey,
        mint,
        authority: wallet.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([vaultKeypair])
      .rpc();

    logger.info({ vault: vaultKeypair.publicKey.toBase58() }, "Flash vault initialized");
  } else {
    // PDA already exists — create a new vault token account and update the stored vault
    logger.info("Flash config PDA already exists — creating new vault and updating...");

    await createAccount(
      connection,
      wallet,
      mint,
      flashConfigPda,   // authority = the PDA (so it can sign transfers)
      vaultKeypair
    );

    logger.info({ vault: vaultKeypair.publicKey.toBase58() }, "New vault token account created");

    await program.methods
      .updateVault()
      .accounts({
        flashConfig: flashConfigPda,
        newVault: vaultKeypair.publicKey,
        authority: wallet.publicKey,
      })
      .rpc();

    logger.info({ vault: vaultKeypair.publicKey.toBase58() }, "Flash config vault updated");
  }

  // Fund the vault with 50,000 fUSDC
  await transfer(
    connection,
    wallet,
    new PublicKey(tokens.tokenA.account),
    vaultKeypair.publicKey,
    wallet,
    50_000 * 10 ** 6
  );

  logger.info("Funded vault with 50,000 fUSDC");

  const vaultBalance = await connection.getTokenAccountBalance(vaultKeypair.publicKey);
  logger.info({ balance: vaultBalance.value.uiAmountString }, "Vault balance confirmed");

  const vaultConfig = {
    flashConfig: flashConfigPda.toBase58(),
    vault: vaultKeypair.publicKey.toBase58(),
    mint: tokens.tokenA.mint,
    programId: programId.toBase58(),
  };

  fs.writeFileSync("config/devnet_flash_vault.json", JSON.stringify(vaultConfig, null, 2));
  logger.info("Flash vault config saved to config/devnet_flash_vault.json");
  logger.info("=== Flash vault setup complete ===");
}

setupFlashVault().catch(console.error);
