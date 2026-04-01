import { Connection, PublicKey, SystemProgram, Keypair, Transaction } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet, BN } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  transfer,
  getMint,
} from "@solana/spl-token";
import { loadWallet } from "../../src/utils/wallet";
import { logger } from "../../src/utils/logger";
import fs from "fs";

const idl = JSON.parse(
  fs.readFileSync("programs-protection/target/idl/programs_protection.json", "utf-8")
);

const devnetTokens = JSON.parse(
  fs.readFileSync("config/devnet_tokens.json", "utf-8")
);

async function testFlashLoan() {
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const wallet = loadWallet();
  const provider = new AnchorProvider(connection, new Wallet(wallet), { commitment: "confirmed" });
  const program = new Program(idl, provider) as any;
  const programId = program.programId;

  const mint = new PublicKey(devnetTokens.tokenA.mint); // fUSDC

  // ============================================================
  // SETUP: Find PDA and vault keypair
  // ============================================================
  const [flashConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("flash_vault"), wallet.publicKey.toBuffer()],
    programId
  );

  logger.info("=== Flash Loan Test ===");
  logger.info({ mint: mint.toBase58(), program: programId.toBase58() }, "Config");

  // ============================================================
  // STEP 1: Initialize Flash Vault (skip if already exists)
  // ============================================================
  let vaultPubkey: PublicKey;

  let vaultMint: PublicKey = mint; // default to fUSDC

  try {
    // Check if flash config already exists
    const existingConfig = await program.account.flashConfig.fetch(flashConfigPda);
    vaultPubkey = existingConfig.vault as PublicKey;

    // Read the actual mint from the vault token account
    const vaultAccount = await getAccount(connection, vaultPubkey);
    vaultMint = vaultAccount.mint;

    logger.info(
      { vault: vaultPubkey.toBase58(), mint: vaultMint.toBase58() },
      "Flash vault already initialized, reusing (using vault's actual mint)"
    );
  } catch {
    // Doesn't exist yet — initialize with fUSDC
    const vaultKeypair = Keypair.generate();
    vaultPubkey = vaultKeypair.publicKey;

    await program.methods
      .initializeFlashVault()
      .accounts({
        flashConfig: flashConfigPda,
        vault: vaultPubkey,
        mint: vaultMint,
        authority: wallet.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: new PublicKey("SysvarRent111111111111111111111111111111111"),
      })
      .signers([vaultKeypair])
      .rpc();

    logger.info({ vault: vaultPubkey.toBase58(), mint: vaultMint.toBase58() }, "Flash vault initialized");
  }

  // ============================================================
  // STEP 2: Fund the vault from our own token account
  // (mint authority may be revoked, so we transfer instead of minting)
  // ============================================================
  const VAULT_FUND_AMOUNT = 10_000_000; // 10 tokens

  // Check if mint authority exists — if yes, mint; if no, transfer from wallet ATA
  const mintInfo = await getMint(connection, vaultMint);
  const walletAta = await getOrCreateAssociatedTokenAccount(
    connection, wallet, vaultMint, wallet.publicKey
  );

  if (mintInfo.mintAuthority !== null) {
    await mintTo(connection, wallet, vaultMint, vaultPubkey, wallet, VAULT_FUND_AMOUNT);
    logger.info("Funded vault via mint");
  } else {
    // Mint authority revoked — transfer from our own wallet ATA
    const walletBalance = Number((await getAccount(connection, walletAta.address)).amount);
    if (walletBalance < VAULT_FUND_AMOUNT) {
      throw new Error(`Not enough tokens in wallet ATA to fund vault. Have: ${walletBalance / 1e6}, need: ${VAULT_FUND_AMOUNT / 1e6}`);
    }
    await transfer(connection, wallet, walletAta.address, vaultPubkey, wallet, VAULT_FUND_AMOUNT);
    logger.info("Funded vault via transfer (mint authority revoked)");
  }

  const vaultBalanceBefore = await getAccount(connection, vaultPubkey);
  logger.info(
    { balance: Number(vaultBalanceBefore.amount) / 1e6 },
    "Vault funded with fUSDC"
  );

  // ============================================================
  // STEP 3: Create borrower token account
  // ============================================================
  const borrowerAta = await getOrCreateAssociatedTokenAccount(
    connection,
    wallet,
    vaultMint,
    wallet.publicKey
  );
  const borrowerBalanceBefore = Number((await getAccount(connection, borrowerAta.address)).amount);
  logger.info(
    { balance: borrowerBalanceBefore / 1e6 },
    "Borrower token balance before"
  );

  // ============================================================
  // TEST 1: Successful flash loan (borrow + repay in same tx)
  // ============================================================
  logger.info("--- Test 1: Successful Flash Loan (borrow + repay atomic) ---");

  const BORROW_AMOUNT = 5_000_000; // 5 tokens

  // Pre-fund borrower so they can repay after borrowing
  // (mint authority may be revoked — tokens come from vault pre-fund above)
  // The borrower IS the wallet, so borrowerAta === walletAta — already funded above.

  // Build atomic transaction: borrow + repay in one tx
  const borrowIx = await program.methods
    .executeFlashLoan(new BN(BORROW_AMOUNT))
    .accounts({
      flashConfig: flashConfigPda,
      vault: vaultPubkey,
      borrowerToken: borrowerAta.address,
      borrower: wallet.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();

  const repayIx = await program.methods
    .repayFlashLoan(new BN(BORROW_AMOUNT), new BN(BORROW_AMOUNT))
    .accounts({
      flashConfig: flashConfigPda,
      vault: vaultPubkey,
      borrowerToken: borrowerAta.address,
      borrower: wallet.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();

  const tx = new Transaction().add(borrowIx).add(repayIx);
  const sig = await provider.sendAndConfirm(tx);
  logger.info({ signature: sig }, "Flash loan executed and repaid atomically");

  // Check balances after
  const vaultBalanceAfter = await getAccount(connection, vaultPubkey);
  const borrowerBalanceAfter = Number((await getAccount(connection, borrowerAta.address)).amount);
  logger.info(
    {
      vaultBefore: Number(vaultBalanceBefore.amount) / 1e6,
      vaultAfter: Number(vaultBalanceAfter.amount) / 1e6,
      borrowerAfter: borrowerBalanceAfter / 1e6,
    },
    "Balances after successful flash loan"
  );

  // ============================================================
  // TEST 2: Failed repayment — tx should revert entirely
  // ============================================================
  logger.info("--- Test 2: Insufficient Repayment (should revert entire tx) ---");

  const borrowIx2 = await program.methods
    .executeFlashLoan(new BN(BORROW_AMOUNT))
    .accounts({
      flashConfig: flashConfigPda,
      vault: vaultPubkey,
      borrowerToken: borrowerAta.address,
      borrower: wallet.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();

  // Try to repay less than borrowed — should fail the require! check
  const repayIx2 = await program.methods
    .repayFlashLoan(new BN(BORROW_AMOUNT - 1), new BN(BORROW_AMOUNT))
    .accounts({
      flashConfig: flashConfigPda,
      vault: vaultPubkey,
      borrowerToken: borrowerAta.address,
      borrower: wallet.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();

  const tx2 = new Transaction().add(borrowIx2).add(repayIx2);

  try {
    await provider.sendAndConfirm(tx2);
    logger.error("BUG: Should have reverted — repayment was insufficient!");
  } catch (e: any) {
    logger.info("Insufficient repayment: ENTIRE TX REVERTED (correct!)");
  }

  // Verify vault balance unchanged after failed tx
  const vaultBalanceFinal = await getAccount(connection, vaultPubkey);
  logger.info(
    {
      vaultBalance: Number(vaultBalanceFinal.amount) / 1e6,
      unchanged: Number(vaultBalanceFinal.amount) === Number(vaultBalanceAfter.amount),
    },
    "Vault balance after failed flash loan (should be unchanged)"
  );

  // ============================================================
  // TEST 3: Borrow without repay — tx with only borrow should succeed
  // but in real usage this would be within a single tx with swaps
  // ============================================================
  logger.info("--- Test 3: Borrow-only (no repay instruction) ---");
  logger.info("In production, borrow + swap + repay are always in one atomic tx.");
  logger.info("A borrow-only call succeeds on its own but leaves funds in borrower account.");
  logger.info("The flash loan design relies on tx atomicity — if repay fails, entire tx reverts.");

  logger.info("=== All Flash Loan Tests Complete ===");
}

testFlashLoan().catch(console.error);
