/**
 * Test the vault program end-to-end on devnet.
 *
 * Tests:
 *   1. Read vault state (should exist from deploy_vault.ts)
 *   2. Check vault token balance
 *   3. Withdraw some tokens
 *   4. Verify balance changed
 *   5. Re-deposit
 *   6. Change bot authority
 *   7. Pause/unpause vault
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet, BN } from "@coral-xyz/anchor";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import fs from "fs";
import { loadWallet } from "../../src/utils/wallet";
import { getConfig } from "../../src/utils/config";
import { logger } from "../../src/utils/logger";

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++;
    logger.info(`  [PASS] ${name}`);
  } else {
    failed++;
    logger.error(`  [FAIL] ${name}${detail ? " — " + detail : ""}`);
  }
}

async function main() {
  const config = getConfig();
  const wallet = loadWallet();
  const connection = new Connection(config.network.rpc_url, "confirmed");
  const provider = new AnchorProvider(connection, new Wallet(wallet), {
    commitment: "confirmed",
  });

  const idl = JSON.parse(
    fs.readFileSync("programs-vault/target/idl/programs_vault.json", "utf-8")
  );
  const vaultProgram = new Program(idl, provider) as any;

  const vaultConfig = JSON.parse(
    fs.readFileSync("config/devnet_vault.json", "utf-8")
  );
  const vaultPda = new PublicKey(vaultConfig.vaultPda);

  logger.info("=== Vault Program Tests ===\n");

  // Test 1: Read vault state
  logger.info("Test 1: Read vault state");
  const vaultState = await vaultProgram.account.userVault.fetch(vaultPda);
  check("Vault exists", !!vaultState);
  check("Owner matches", vaultState.owner.toBase58() === wallet.publicKey.toBase58());
  check("Bot is authorized", vaultState.bot.toBase58() === wallet.publicKey.toBase58());
  check("Vault is active", vaultState.isActive === true);
  check("Has deposits", vaultState.totalDeposits.toNumber() > 0);

  // Test 2: Check vault token balance
  logger.info("\nTest 2: Check vault token balance");
  const tokens = JSON.parse(fs.readFileSync("config/devnet_tokens.json", "utf-8"));
  const fusdcMint = new PublicKey(tokens.tokenA.mint);
  const vaultAta = await getAssociatedTokenAddress(fusdcMint, vaultPda, true);
  const balance = await connection.getTokenAccountBalance(vaultAta);
  const balanceNum = parseFloat(balance.value.uiAmountString!);
  logger.info({ balance: balanceNum }, "Vault fUSDC balance");
  check("Vault has tokens", balanceNum > 0);

  // Test 3: Withdraw 100 fUSDC
  logger.info("\nTest 3: Withdraw 100 fUSDC");
  const userAta = await getAssociatedTokenAddress(fusdcMint, wallet.publicKey);
  const withdrawAmount = new BN(100 * 10 ** tokens.tokenA.decimals);

  try {
    await vaultProgram.methods
      .withdraw(withdrawAmount)
      .accounts({
        userVault: vaultPda,
        vaultToken: vaultAta,
        userToken: userAta,
        mint: fusdcMint,
        user: wallet.publicKey,
        tokenProgram: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      })
      .rpc();

    const balAfter = await connection.getTokenAccountBalance(vaultAta);
    const balAfterNum = parseFloat(balAfter.value.uiAmountString!);
    check("Balance decreased", balAfterNum < balanceNum);
    check("Withdrew correct amount", Math.abs(balanceNum - balAfterNum - 100) < 0.01);
  } catch (e: any) {
    check("Withdraw succeeded", false, e.message);
  }

  // Test 4: Re-deposit 100 fUSDC
  logger.info("\nTest 4: Re-deposit 100 fUSDC");
  const depositAmount = new BN(100 * 10 ** tokens.tokenA.decimals);

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

    const balFinal = await connection.getTokenAccountBalance(vaultAta);
    const balFinalNum = parseFloat(balFinal.value.uiAmountString!);
    check("Balance restored", Math.abs(balFinalNum - balanceNum) < 0.01);
  } catch (e: any) {
    check("Re-deposit succeeded", false, e.message);
  }

  // Test 5: Pause vault
  logger.info("\nTest 5: Pause/unpause vault");
  try {
    await vaultProgram.methods
      .setActive(false)
      .accounts({
        userVault: vaultPda,
        user: wallet.publicKey,
      })
      .rpc();

    const pausedState = await vaultProgram.account.userVault.fetch(vaultPda);
    check("Vault paused", pausedState.isActive === false);

    // Unpause
    await vaultProgram.methods
      .setActive(true)
      .accounts({
        userVault: vaultPda,
        user: wallet.publicKey,
      })
      .rpc();

    const unpausedState = await vaultProgram.account.userVault.fetch(vaultPda);
    check("Vault unpaused", unpausedState.isActive === true);
  } catch (e: any) {
    check("Pause/unpause succeeded", false, e.message);
  }

  // Test 6: bot_swap — vault PDA as swap authority via CPI to AMM
  logger.info("\nTest 6: bot_swap (vault PDA → AMM CPI)");
  try {
    const pools = JSON.parse(fs.readFileSync("config/devnet_pools.json", "utf-8"));
    const fsolMint = new PublicKey(tokens.tokenB.mint);
    const ataProgram = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
    const tokenProgram = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    const sysProgram = new PublicKey("11111111111111111111111111111111");
    const ammProgramId = new PublicKey("CzpMFPxKuL2qSXiZUGmYEdY6LSbD1zdmK25ZNpjukR9K");

    const vaultTokenA = await getAssociatedTokenAddress(fusdcMint, vaultPda, true);
    const vaultTokenB = await getAssociatedTokenAddress(fsolMint, vaultPda, true);

    const balABefore = await connection.getTokenAccountBalance(vaultTokenA);
    const fusdcBefore = parseFloat(balABefore.value.uiAmountString!);

    // Try to fetch B; may not exist yet
    let fsolBefore = 0;
    try {
      const balBBefore = await connection.getTokenAccountBalance(vaultTokenB);
      fsolBefore = parseFloat(balBBefore.value.uiAmountString!);
    } catch { fsolBefore = 0; }

    const swapAmount = new BN(10 * 10 ** tokens.tokenA.decimals); // 10 fUSDC
    await vaultProgram.methods
      .botSwap(swapAmount, new BN(1), true) // a_to_b = true (fUSDC → fSOL)
      .accounts({
        userVault: vaultPda,
        pool: new PublicKey(pools.pool1.address),
        tokenAVault: new PublicKey(pools.pool1.tokenAVault),
        tokenBVault: new PublicKey(pools.pool1.tokenBVault),
        vaultTokenA,
        vaultTokenB,
        bot: wallet.publicKey,
        ammProgram: ammProgramId,
        tokenProgram,
        associatedTokenProgram: ataProgram,
        systemProgram: sysProgram,
      })
      .preInstructions([
        // Idempotently create vault_token_b in case it doesn't exist
        require("@solana/spl-token").createAssociatedTokenAccountIdempotentInstruction(
          wallet.publicKey, vaultTokenB, vaultPda, fsolMint,
        ),
      ])
      .rpc();

    const balAAfter = await connection.getTokenAccountBalance(vaultTokenA);
    const balBAfter = await connection.getTokenAccountBalance(vaultTokenB);
    const fusdcAfter = parseFloat(balAAfter.value.uiAmountString!);
    const fsolAfter = parseFloat(balBAfter.value.uiAmountString!);

    check("bot_swap: vault fUSDC decreased by 10", Math.abs(fusdcBefore - fusdcAfter - 10) < 0.01);
    check("bot_swap: vault fSOL increased", fsolAfter > fsolBefore);
    logger.info({ fusdcBefore, fusdcAfter, fsolBefore, fsolAfter }, "bot_swap balances");
  } catch (e: any) {
    check("bot_swap succeeded", false, e.message);
  }

  // Summary
  logger.info(`\n=== Results: ${passed}/${passed + failed} passed ===`);
  if (failed > 0) {
    logger.error(`${failed} test(s) FAILED`);
    process.exit(1);
  } else {
    logger.info("All tests passed!");
  }
}

main().catch((err) => {
  logger.error({ err }, "Test vault failed");
  process.exit(1);
});
