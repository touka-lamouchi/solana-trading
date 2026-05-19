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
   * Generic N-hop flash-arb transaction builder (Production Arbitrage Phase 3).
   *
   * Takes a ranked cycle from arb_graph_builder and assembles:
   *   compute-budget headers → flash_borrow → swap×N → flash_repay → optional sweep
   *
   * Differences from buildFlashLoanArbTransaction:
   *   - Hop count is dynamic (any N ≥ 2), not hardcoded to 3
   *   - Each hop's swap direction is derived from the edge's fromMint vs the
   *     pool's mintA (no positional assumptions about pool order)
   *   - Pool config is looked up by poolKey, not by symbol pair
   *
   * The builder is otherwise byte-compatible with the legacy AMM swap and
   * flash-loan instructions, so the existing on-chain programs need no changes.
   */
  async buildCycleArbTransaction(opts: {
    /** Sequence of edges from the cycle finder. cycle[0].fromMint is the base mint. */
    cycle: Array<{
      poolKey: string;
      fromMint: string;
      toMint: string;
      // amountIn / amountOut for *this* hop, in human (decimals-applied) units.
      amountIn: number;
      amountOut: number;
    }>;
    pools: any;          // devnet_pools.json
    flashProgram: any;
    flashConfig: string;
    flashVault: string;
    /** Borrow amount in human units (cycle[0].amountIn typically). */
    borrowAmount: number;
    /** Decimals of the base token being borrowed. */
    borrowDecimals: number;
    profitSweep?: {
      vaultPda: PublicKey;
      baseMint: PublicKey;
      profitRaw: BN;
    };
  }): Promise<Transaction> {
    const { cycle, pools, flashProgram, flashConfig, flashVault,
            borrowAmount, borrowDecimals, profitSweep } = opts;

    if (cycle.length < 2) {
      throw new Error(`buildCycleArbTransaction needs ≥2 hops, got ${cycle.length}`);
    }

    logger.info({ hops: cycle.length, borrowAmount, base: this.tokens.tokenA.name },
      "Building generic cycle arb transaction");

    const tx = new Transaction();
    const cfg = getConfig();
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: cfg.fees.base_priority_fee_microlamports,
    }));
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({
      units: cfg.fees.flash_loan_compute_units,
    }));

    // 1. Flash borrow the base token. We always borrow into the bot wallet's
    //    base-token ATA (tokens.tokenA.account), then sweep profits later.
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
    tx.add(borrowIx);

    // 2. Walk the cycle, one swap instruction per hop.
    for (let i = 0; i < cycle.length; i++) {
      const hop = cycle[i]!;
      const pool = this.findPoolByKey(pools, hop.poolKey);
      if (!pool) throw new Error(`Pool ${hop.poolKey} not found in pools config`);

      // Determine swap direction: a_to_b iff hop.fromMint corresponds to pool.tokenA.
      const aToB = this.mintMatchesSide(pool, hop.fromMint, "A");
      const fromSymbol = aToB ? pool.tokenA : pool.tokenB;
      const toSymbol = aToB ? pool.tokenB : pool.tokenA;
      const decimalsIn = this.getDecimals(fromSymbol);

      const amountInRaw = new BN(Math.floor(hop.amountIn * 10 ** decimalsIn));
      const swapIx = await this.ammProgram.methods
        .swap(amountInRaw, new BN(1), aToB)
        .accounts({
          pool: new PublicKey(pool.address),
          tokenAVault: new PublicKey(pool.tokenAVault),
          tokenBVault: new PublicKey(pool.tokenBVault),
          userTokenA: new PublicKey(this.getTokenAccount(pool.tokenA)),
          userTokenB: new PublicKey(this.getTokenAccount(pool.tokenB)),
          user: this.wallet.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction();
      tx.add(swapIx);

      logger.debug({
        hop: i + 1, pool: hop.poolKey, dir: aToB ? "A→B" : "B→A",
        from: fromSymbol, to: toSymbol, amountIn: hop.amountIn,
      }, "  cycle hop");
    }

    // 3. Repay the flash loan (at least the borrowed amount).
    const repayIx = await flashProgram.methods
      .flashRepay(borrowAmountRaw, borrowAmountRaw)
      .accounts({
        flashConfig: new PublicKey(flashConfig),
        vault: new PublicKey(flashVault),
        borrowerToken: new PublicKey(this.tokens.tokenA.account),
        borrower: this.wallet.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    tx.add(repayIx);

    // 4. Optional profit sweep: bot ATA → user vault ATA, atomically.
    let sweepFlow = "";
    if (profitSweep && profitSweep.profitRaw.gtn(0)) {
      const botAta = new PublicKey(this.tokens.tokenA.account);
      const vaultAta = await getAssociatedTokenAddress(
        profitSweep.baseMint, profitSweep.vaultPda, true,
      );
      tx.add(createAssociatedTokenAccountIdempotentInstruction(
        this.wallet.publicKey, vaultAta, profitSweep.vaultPda, profitSweep.baseMint,
      ));
      tx.add(createTransferInstruction(
        botAta, vaultAta, this.wallet.publicKey,
        BigInt(profitSweep.profitRaw.toString()),
      ));
      sweepFlow = " → sweep profit→vault";
    }

    const { blockhash } = await this.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = this.wallet.publicKey;

    logger.info({
      instructions: tx.instructions.length,
      flow: `borrow → swap × ${cycle.length} → repay${sweepFlow}`,
    }, "Generic cycle arb transaction built");

    return tx;
  }

  private findPoolByKey(pools: any, poolKey: string): any | null {
    if (pools[poolKey]) return pools[poolKey];
    // pools config may be keyed by symbolic name; search by address too.
    for (const k of Object.keys(pools)) {
      if (pools[k]?.address === poolKey) return pools[k];
    }
    return null;
  }

  private mintMatchesSide(pool: any, mint: string, side: "A" | "B"): boolean {
    const explicit = side === "A" ? pool.tokenAMint : pool.tokenBMint;
    if (explicit) return explicit === mint;
    // Resolve through tokens config by symbol.
    const symbol: string = side === "A" ? pool.tokenA : pool.tokenB;
    for (const key of Object.keys(this.tokens)) {
      const t = this.tokens[key];
      if (t?.name === symbol) return t.mint === mint;
    }
    return false;
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