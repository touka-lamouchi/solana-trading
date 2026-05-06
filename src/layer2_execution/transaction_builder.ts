import {
  Connection, PublicKey, Transaction, ComputeBudgetProgram, SYSVAR_INSTRUCTIONS_PUBKEY, Keypair,
} from "@solana/web3.js";
import { Program, BN } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  createTransferInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import { SwapRoute } from "./route_planner";
import { FeeCalculator } from "./fee_calculator";
import { SlippageGuard } from "../protection/slippage_guard";
import { logger } from "../utils/logger";
import { getConfig } from "../utils/config";

export class TransactionBuilder {
  private connection: Connection;
  private ammProgram: any;
  private feeCalculator: FeeCalculator;
  private slippageGuard: SlippageGuard;
  private wallet: Keypair;
  private tokens: any;

  constructor(
    connection: Connection,
    ammProgram: Program,
    slippageGuard: SlippageGuard,
    tokens: any,
    userKeypair: Keypair,
  ) {
    this.connection = connection;
    this.ammProgram = ammProgram;
    this.feeCalculator = new FeeCalculator(connection);
    this.slippageGuard = slippageGuard;
    this.wallet = userKeypair;
    this.tokens = tokens;
  }

  private getTokenAccount(tokenName: string): string {
    // Look up by name field across all token entries in devnet_tokens.json
    for (const key of Object.keys(this.tokens)) {
      if (this.tokens[key].name === tokenName) return this.tokens[key].account;
    }
    throw new Error(`Unknown token: ${tokenName}`);
  }

  private getDecimals(tokenName: string): number {
    for (const key of Object.keys(this.tokens)) {
      if (this.tokens[key].name === tokenName) return this.tokens[key].decimals;
    }
    return 6; // fallback
  }

  private getTokenNames(step: any, pools: any): { tokenA: string; tokenB: string } {
    for (const poolKey of Object.keys(pools)) {
      if (pools[poolKey].address === step.poolAddress) {
        return { tokenA: pools[poolKey].tokenA, tokenB: pools[poolKey].tokenB };
      }
    }
    throw new Error("Pool not found");
  }

  async buildSwapTransaction(
    route: SwapRoute,
    pools: any,
    estimatedProfit: number
  ): Promise<Transaction> {
    logger.info({ hops: route.poolCount, amountIn: route.amountIn }, "Building swap transaction");

    const transaction = new Transaction();

    const cfg = getConfig();
    const priorityFee = await this.feeCalculator.calculatePriorityFee(estimatedProfit);
    transaction.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }));
    transaction.add(ComputeBudgetProgram.setComputeUnitLimit({
      units: route.poolCount * cfg.fees.compute_units_per_hop,
    }));

    for (let i = 0; i < route.steps.length; i++) {
      const step = route.steps[i]!;
      const { tokenA, tokenB } = this.getTokenNames(step, pools);

      const inputToken = step.aToB ? tokenA : tokenB;
      const decimalsIn = this.getDecimals(inputToken);
      const amountIn = i === 0 ? route.amountIn : route.steps[i - 1]!.expectedOutput;
      const amountInRaw = new BN(Math.floor(amountIn * 10 ** decimalsIn));

      const minOutput = new BN(1); // relaxed for devnet

      const ix = await this.ammProgram.methods
        .swap(amountInRaw, minOutput, step.aToB)
        .accounts({
          pool: new PublicKey(step.poolAddress),
          tokenAVault: new PublicKey(step.tokenAVault),
          tokenBVault: new PublicKey(step.tokenBVault),
          userTokenA: new PublicKey(this.getTokenAccount(tokenA)),
          userTokenB: new PublicKey(this.getTokenAccount(tokenB)),
          user: this.wallet.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction();

      transaction.add(ix);
    }

    const { blockhash } = await this.connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = this.wallet.publicKey;

    logger.info({ instructions: transaction.instructions.length }, "Swap transaction built");
    return transaction;
  }

  async buildFlashLoanArbTransaction(
    route: SwapRoute,
    pools: any,
    flashProgram: any,
    flashConfig: string,
    flashVault: string,
    borrowAmount: number,
    borrowDecimals: number,
    profitSweep?: {
      vaultPda: PublicKey;
      baseMint: PublicKey;
      profitRaw: BN;
    },
  ): Promise<Transaction> {
    logger.info({ hops: route.poolCount, borrowAmount }, "Building flash loan arb transaction");

    const transaction = new Transaction();

    const flashCfg = getConfig();
    transaction.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: flashCfg.fees.base_priority_fee_microlamports }));
    transaction.add(ComputeBudgetProgram.setComputeUnitLimit({ units: flashCfg.fees.flash_loan_compute_units }));

    // Instruction 1: Borrow from flash vault
    const borrowAmountRaw = new BN(Math.floor(borrowAmount * 10 ** borrowDecimals));

    const borrowIx = await flashProgram.methods
      .flashBorrow(borrowAmountRaw)
      .accounts({
        flashConfig: new PublicKey(flashConfig),
        vault: new PublicKey(flashVault),
        borrowerToken: new PublicKey(this.tokens.tokenA.account),
        borrower: this.wallet.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    transaction.add(borrowIx);

    // Instructions 2-4: Execute the arb swaps
    for (let i = 0; i < route.steps.length; i++) {
      const step = route.steps[i]!;
      const { tokenA, tokenB } = this.getTokenNames(step, pools);

      const inputToken = step.aToB ? tokenA : tokenB;
      const decimalsIn = this.getDecimals(inputToken);
      const amountIn = i === 0 ? route.amountIn : route.steps[i - 1]!.expectedOutput;
      const amountInRaw = new BN(Math.floor(amountIn * 10 ** decimalsIn));

      const ix = await this.ammProgram.methods
        .swap(amountInRaw, new BN(1), step.aToB)
        .accounts({
          pool: new PublicKey(step.poolAddress),
          tokenAVault: new PublicKey(step.tokenAVault),
          tokenBVault: new PublicKey(step.tokenBVault),
          userTokenA: new PublicKey(this.getTokenAccount(tokenA)),
          userTokenB: new PublicKey(this.getTokenAccount(tokenB)),
          user: this.wallet.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction();

      transaction.add(ix);
    }

    // Instruction 5: Repay flash loan
    const repayAmountRaw = borrowAmountRaw; // repay at least what was borrowed

    const repayIx = await flashProgram.methods
      .flashRepay(repayAmountRaw, borrowAmountRaw)
      .accounts({
        flashConfig: new PublicKey(flashConfig),
        vault: new PublicKey(flashVault),
        borrowerToken: new PublicKey(this.tokens.tokenA.account),
        borrower: this.wallet.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    transaction.add(repayIx);

    // Optional: sweep profit from bot's fUSDC ATA → user's vault ATA atomically.
    // If the swaps fail, the sweep doesn't run; if they succeed, the profit
    // lands in the vault before the tx confirms.
    let sweepFlow = "";
    if (profitSweep && profitSweep.profitRaw.gtn(0)) {
      const botAta = new PublicKey(this.tokens.tokenA.account);
      const vaultAta = await getAssociatedTokenAddress(
        profitSweep.baseMint,
        profitSweep.vaultPda,
        true,
      );

      transaction.add(
        createAssociatedTokenAccountIdempotentInstruction(
          this.wallet.publicKey,
          vaultAta,
          profitSweep.vaultPda,
          profitSweep.baseMint,
        ),
      );

      transaction.add(
        createTransferInstruction(
          botAta,
          vaultAta,
          this.wallet.publicKey,
          BigInt(profitSweep.profitRaw.toString()),
        ),
      );

      sweepFlow = " → sweep profit→vault";
    }

    const { blockhash } = await this.connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = this.wallet.publicKey;

    logger.info({
      instructions: transaction.instructions.length,
      flow: "borrow → swap × " + route.poolCount + " → repay" + sweepFlow,
    }, "Flash loan arb transaction built");

    return transaction;
  }

  /**
   * Build a single-hop swap that goes through the user's vault PDA as the
   * swap authority. Calls programs_vault.bot_swap, which CPIs the AMM with
   * the vault PDA signing — tokens never touch the bot wallet.
   *
   * Pre-creates the destination vault ATA via idempotent ATA-init in the same
   * tx (in case it doesn't exist yet for a fresh vault).
   */
  async buildVaultSwapTransaction(opts: {
    route: SwapRoute;
    pools: any;
    estimatedProfit: number;
    vaultProgram: any;
    vaultPda: PublicKey;
    botPubkey: PublicKey;
    mintIn: PublicKey;
    mintOut: PublicKey;
    ammProgramId: PublicKey;
  }): Promise<Transaction> {
    const { route, pools, estimatedProfit, vaultProgram, vaultPda, botPubkey, mintIn, mintOut, ammProgramId } = opts;
    if (route.steps.length !== 1) {
      throw new Error("buildVaultSwapTransaction supports exactly 1 hop");
    }
    const step = route.steps[0]!;
    const { tokenA } = this.getTokenNames(step, pools);
    const decimalsIn = this.getDecimals(step.aToB ? tokenA : this.getTokenNames(step, pools).tokenB);
    const amountInRaw = new BN(Math.floor(route.amountIn * 10 ** decimalsIn));

    // The vault's per-mint ATAs (vault PDA is the SPL owner)
    const vaultTokenIn = await getAssociatedTokenAddress(mintIn, vaultPda, true);
    const vaultTokenOut = await getAssociatedTokenAddress(mintOut, vaultPda, true);

    const tx = new Transaction();
    const cfg = getConfig();
    const priorityFee = await this.feeCalculator.calculatePriorityFee(estimatedProfit);
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }));
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: cfg.fees.compute_units_per_hop }));

    // Pre-create both vault ATAs idempotently (no-op if they already exist)
    tx.add(createAssociatedTokenAccountIdempotentInstruction(botPubkey, vaultTokenIn, vaultPda, mintIn));
    tx.add(createAssociatedTokenAccountIdempotentInstruction(botPubkey, vaultTokenOut, vaultPda, mintOut));

    // Account order matches BotSwap struct in programs_vault/lib.rs:
    //   user_vault, pool, token_a_vault, token_b_vault,
    //   vault_token_a (in), vault_token_b (out), bot, amm_program, token_program, ata_program, system_program
    const swapIx = await vaultProgram.methods
      .botSwap(amountInRaw, new BN(1), step.aToB)
      .accounts({
        userVault: vaultPda,
        pool: new PublicKey(step.poolAddress),
        tokenAVault: new PublicKey(step.tokenAVault),
        tokenBVault: new PublicKey(step.tokenBVault),
        vaultTokenA: vaultTokenIn,
        vaultTokenB: vaultTokenOut,
        bot: botPubkey,
        ammProgram: ammProgramId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
        systemProgram: new PublicKey("11111111111111111111111111111111"),
      })
      .instruction();
    tx.add(swapIx);

    const { blockhash } = await this.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = this.wallet.publicKey;

    logger.info({
      instructions: tx.instructions.length,
      flow: "vault.bot_swap → AMM CPI (vault PDA authority)",
    }, "Vault swap transaction built");
    return tx;
  }

  /**
   * Triangular arb routed through the vault PDA. Calls programs_vault.bot_arb,
   * which CPIs the AMM 3 times (A→B, B→C, C→A) with the vault PDA as
   * authority. Uses VAULT capital — no flash loan. Profit accumulates in
   * vault_token_a (the base mint).
   *
   * Pre-creates all three vault ATAs idempotently in the same tx.
   */
  async buildVaultArbTransaction(opts: {
    pools: { p1: any; p2: any; p3: any };
    directions: [boolean, boolean, boolean]; // a_to_b for each hop
    amountIn: number;
    estimatedProfit: number;
    vaultProgram: any;
    vaultPda: PublicKey;
    botPubkey: PublicKey;
    mintA: PublicKey;
    mintB: PublicKey;
    mintC: PublicKey;
    ammProgramId: PublicKey;
    decimalsA: number;
  }): Promise<Transaction> {
    const { pools, directions, amountIn, estimatedProfit,
            vaultProgram, vaultPda, botPubkey,
            mintA, mintB, mintC, ammProgramId, decimalsA } = opts;

    const amountInRaw = new BN(Math.floor(amountIn * 10 ** decimalsA));

    const vaultTokenA = await getAssociatedTokenAddress(mintA, vaultPda, true);
    const vaultTokenB = await getAssociatedTokenAddress(mintB, vaultPda, true);
    const vaultTokenC = await getAssociatedTokenAddress(mintC, vaultPda, true);

    const tx = new Transaction();
    const cfg = getConfig();
    const priorityFee = await this.feeCalculator.calculatePriorityFee(estimatedProfit);
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }));
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: cfg.fees.flash_loan_compute_units }));

    // Idempotent ATA creation for all three vault token accounts
    tx.add(createAssociatedTokenAccountIdempotentInstruction(botPubkey, vaultTokenA, vaultPda, mintA));
    tx.add(createAssociatedTokenAccountIdempotentInstruction(botPubkey, vaultTokenB, vaultPda, mintB));
    tx.add(createAssociatedTokenAccountIdempotentInstruction(botPubkey, vaultTokenC, vaultPda, mintC));

    const arbIx = await vaultProgram.methods
      .botArb(amountInRaw, directions)
      .accounts({
        userVault: vaultPda,
        pool1: new PublicKey(pools.p1.address),
        pool1VaultA: new PublicKey(pools.p1.tokenAVault),
        pool1VaultB: new PublicKey(pools.p1.tokenBVault),
        pool2: new PublicKey(pools.p2.address),
        pool2VaultA: new PublicKey(pools.p2.tokenAVault),
        pool2VaultB: new PublicKey(pools.p2.tokenBVault),
        pool3: new PublicKey(pools.p3.address),
        pool3VaultA: new PublicKey(pools.p3.tokenAVault),
        pool3VaultB: new PublicKey(pools.p3.tokenBVault),
        vaultTokenA,
        vaultTokenB,
        vaultTokenC,
        bot: botPubkey,
        ammProgram: ammProgramId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
        systemProgram: new PublicKey("11111111111111111111111111111111"),
      })
      .instruction();
    tx.add(arbIx);

    const { blockhash } = await this.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = this.wallet.publicKey;

    logger.info({
      instructions: tx.instructions.length,
      flow: "vault.bot_arb → AMM CPI × 3 (vault PDA authority, vault capital)",
    }, "Vault arb transaction built");
    return tx;
  }

  /**
   * Triangular arb FUNDED BY A FLASH LOAN, all under the vault PDA's authority.
   * Calls vault.bot_arb_via_flash, which CPIs flash_borrow → swap×3 → flash_repay
   * as nested calls. Tokens never touch the bot wallet at any point.
   *
   * Strict atomicity: any failure inside reverts the entire transaction.
   */
  async buildVaultArbViaFlashTransaction(opts: {
    pools: { p1: any; p2: any; p3: any };
    directions: [boolean, boolean, boolean];
    borrowAmount: number;
    estimatedProfit: number;
    vaultProgram: any;
    vaultPda: PublicKey;
    botPubkey: PublicKey;
    mintA: PublicKey;
    mintB: PublicKey;
    mintC: PublicKey;
    ammProgramId: PublicKey;
    flashProgramId: PublicKey;
    flashConfig: PublicKey;
    flashVault: PublicKey;
    decimalsA: number;
  }): Promise<Transaction> {
    const { pools, directions, borrowAmount, estimatedProfit,
            vaultProgram, vaultPda, botPubkey,
            mintA, mintB, mintC,
            ammProgramId, flashProgramId, flashConfig, flashVault,
            decimalsA } = opts;

    const borrowRaw = new BN(Math.floor(borrowAmount * 10 ** decimalsA));

    const vaultTokenA = await getAssociatedTokenAddress(mintA, vaultPda, true);
    const vaultTokenB = await getAssociatedTokenAddress(mintB, vaultPda, true);
    const vaultTokenC = await getAssociatedTokenAddress(mintC, vaultPda, true);

    const tx = new Transaction();
    const cfg = getConfig();
    const priorityFee = await this.feeCalculator.calculatePriorityFee(estimatedProfit);
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }));
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: cfg.fees.flash_loan_compute_units }));

    tx.add(createAssociatedTokenAccountIdempotentInstruction(botPubkey, vaultTokenA, vaultPda, mintA));
    tx.add(createAssociatedTokenAccountIdempotentInstruction(botPubkey, vaultTokenB, vaultPda, mintB));
    tx.add(createAssociatedTokenAccountIdempotentInstruction(botPubkey, vaultTokenC, vaultPda, mintC));

    const arbIx = await vaultProgram.methods
      .botArbViaFlash(borrowRaw, directions)
      .accounts({
        userVault: vaultPda,
        flashConfig,
        flashVault,
        pool1: new PublicKey(pools.p1.address),
        pool1VaultA: new PublicKey(pools.p1.tokenAVault),
        pool1VaultB: new PublicKey(pools.p1.tokenBVault),
        pool2: new PublicKey(pools.p2.address),
        pool2VaultA: new PublicKey(pools.p2.tokenAVault),
        pool2VaultB: new PublicKey(pools.p2.tokenBVault),
        pool3: new PublicKey(pools.p3.address),
        pool3VaultA: new PublicKey(pools.p3.tokenAVault),
        pool3VaultB: new PublicKey(pools.p3.tokenBVault),
        vaultTokenA,
        vaultTokenB,
        vaultTokenC,
        bot: botPubkey,
        ammProgram: ammProgramId,
        flashProgram: flashProgramId,
        tokenProgram: TOKEN_PROGRAM_ID,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();
    tx.add(arbIx);

    const { blockhash } = await this.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = this.wallet.publicKey;

    logger.info({
      instructions: tx.instructions.length,
      flow: "vault.bot_arb_via_flash → CPI(flash_borrow → swap×3 → flash_repay), vault PDA custodian throughout",
    }, "Vault flash-arb transaction built");
    return tx;
  }

  async signAndSend(transaction: Transaction): Promise<string> {
    transaction.sign(this.wallet);
    logger.info("Submitting transaction...");

    const signature = await this.connection.sendRawTransaction(
      transaction.serialize(),
      { skipPreflight: false, preflightCommitment: "confirmed" }
    );

    logger.info({ signature }, "Submitted, waiting for confirmation...");

    const confirmation = await this.connection.confirmTransaction(signature, "confirmed");

    if (confirmation.value.err) {
      logger.error({ error: confirmation.value.err }, "Transaction FAILED on-chain");
      throw new Error("Transaction failed on-chain");
    }

    logger.info({ signature }, "Transaction CONFIRMED");
    return signature;
  }
}