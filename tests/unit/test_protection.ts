import { Connection, PublicKey, SystemProgram, Keypair } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet, BN, web3 } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID, getOrCreateAssociatedTokenAccount, mintTo, createMint } from "@solana/spl-token";
import { loadWallet } from "../../src/utils/wallet";
import { logger } from "../../src/utils/logger";
import fs from "fs";

const idl = JSON.parse(
  fs.readFileSync("programs-protection/target/idl/programs_protection.json", "utf-8")
);

async function testProtection() {
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const wallet = loadWallet();
  const provider = new AnchorProvider(connection, new Wallet(wallet), { commitment: "confirmed" });

  const program = new Program(idl, provider) as any;
  const programId = program.programId;

  // ============================================================
  // TEST 1: AUTO-PAUSE
  // ============================================================
  logger.info("=== Test 1: Auto-Pause ===");

  const [autoPausePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("auto_pause"), wallet.publicKey.toBuffer()],
    programId
  );

  // Initialize (skip if already exists from previous run)
  try {
    await program.methods
      .initializeAutoPause(3)
      .accounts({
        autoPause: autoPausePda,
        authority: wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    logger.info("Auto-pause initialized (max 3 failures)");
  } catch (e: any) {
    logger.info("Auto-pause PDA already exists, resetting state");
    await program.methods
      .resetAutoPause()
      .accounts({ autoPause: autoPausePda, authority: wallet.publicKey })
      .rpc();
    logger.info("Auto-pause reset to clean state");
  }

  // Check can trade — should pass
  await program.methods
    .checkCanTrade()
    .accounts({ autoPause: autoPausePda })
    .rpc();
  logger.info("Check can trade: ALLOWED");

  // Record 2 failures
  await program.methods
    .recordTradeResult(false)
    .accounts({ autoPause: autoPausePda, authority: wallet.publicKey })
    .rpc();
  logger.info("Recorded failure 1");

  await program.methods
    .recordTradeResult(false)
    .accounts({ autoPause: autoPausePda, authority: wallet.publicKey })
    .rpc();
  logger.info("Recorded failure 2");

  // Should still be allowed (2 < 3)
  await program.methods
    .checkCanTrade()
    .accounts({ autoPause: autoPausePda })
    .rpc();
  logger.info("Check can trade after 2 failures: STILL ALLOWED");

  // Record failure 3 — should trigger pause
  await program.methods
    .recordTradeResult(false)
    .accounts({ autoPause: autoPausePda, authority: wallet.publicKey })
    .rpc();
  logger.info("Recorded failure 3 — pause should trigger");

  // Check can trade — should FAIL
  try {
    await program.methods
      .checkCanTrade()
      .accounts({ autoPause: autoPausePda })
      .rpc();
    logger.error("BUG: Should have been paused!");
  } catch (e: any) {
    logger.info("Check can trade after 3 failures: BLOCKED (correct!)");
  }

  // Reset
  await program.methods
    .resetAutoPause()
    .accounts({ autoPause: autoPausePda, authority: wallet.publicKey })
    .rpc();
  logger.info("Auto-pause reset by authority");

  // Should work again
  await program.methods
    .checkCanTrade()
    .accounts({ autoPause: autoPausePda })
    .rpc();
  logger.info("Check can trade after reset: ALLOWED");

  // Record a success — should reset counter
  await program.methods
    .recordTradeResult(true)
    .accounts({ autoPause: autoPausePda, authority: wallet.publicKey })
    .rpc();
  logger.info("Recorded success — counter reset to 0");

  // ============================================================
  // TEST 2: DRAWDOWN VAULT
  // ============================================================
  logger.info("=== Test 2: Drawdown Vault ===");

  const [drawdownPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("drawdown"), wallet.publicKey.toBuffer()],
    programId
  );

  // Initialize (skip if already exists from previous run)
  try {
    await program.methods
      .initializeDrawdown(new BN(1000))
      .accounts({
        drawdown: drawdownPda,
        authority: wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    logger.info("Drawdown initialized (daily limit: 1000)");
  } catch (e: any) {
    logger.info("Drawdown PDA already exists, resetting state");
    await program.methods
      .resetDrawdown(new BN(1000))
      .accounts({ drawdown: drawdownPda, authority: wallet.publicKey })
      .rpc();
    logger.info("Drawdown reset (limit: 1000, spent: 0, unpaused)");
  }

  // Request 400 — should pass
  await program.methods
    .requestCapital(new BN(400))
    .accounts({ drawdown: drawdownPda, authority: wallet.publicKey })
    .rpc();
  logger.info("Requested 400: APPROVED (total: 400/1000)");

  // Request 400 more — should pass
  await program.methods
    .requestCapital(new BN(400))
    .accounts({ drawdown: drawdownPda, authority: wallet.publicKey })
    .rpc();
  logger.info("Requested 400: APPROVED (total: 800/1000)");

  // Request 200 more — should trigger auto-pause at 90%
  await program.methods
    .requestCapital(new BN(200))
    .accounts({ drawdown: drawdownPda, authority: wallet.publicKey })
    .rpc();
  logger.info("Requested 200: APPROVED but AUTO-PAUSED at 90% (total: 1000/1000)");

  // Request anything more — should FAIL (paused)
  try {
    await program.methods
      .requestCapital(new BN(1))
      .accounts({ drawdown: drawdownPda, authority: wallet.publicKey })
      .rpc();
    logger.error("BUG: Should have been paused!");
  } catch (e: any) {
    logger.info("Requested 1 more: BLOCKED — drawdown paused (correct!)");
  }

  // ============================================================
  // TEST 3: SLIPPAGE GUARD
  // ============================================================
  logger.info("=== Test 3: Slippage Guard ===");

  // Good slippage — should pass
  await program.methods
    .checkSlippage(new BN(990), new BN(950), 500) // output=990, min=950, max 5%
    .accounts({ user: wallet.publicKey })
    .rpc();
  logger.info("Slippage check (990 >= 950): PASSED");

  // Bad slippage — should FAIL
  try {
    await program.methods
      .checkSlippage(new BN(900), new BN(950), 500) // output=900 < min=950
      .accounts({ user: wallet.publicKey })
      .rpc();
    logger.error("BUG: Should have failed slippage check!");
  } catch (e: any) {
    logger.info("Slippage check (900 < 950): BLOCKED (correct!)");
  }

  logger.info("=== All protection tests complete ===");
}

testProtection().catch(console.error);
