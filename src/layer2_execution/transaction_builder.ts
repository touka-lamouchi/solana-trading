import {
  Connection, PublicKey, Transaction, ComputeBudgetProgram, SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import { Program, BN } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { SwapRoute } from "./route_planner";
import { FeeCalculator } from "./fee_calculator";
import { SlippageGuard } from "../protection/slippage_guard";
import { logger } from "../utils/logger";
import { loadWallet } from "../utils/wallet";
import { getConfig } from "../utils/config";

export class TransactionBuilder {
  private connection: Connection;
  private ammProgram: any;
  private feeCalculator: FeeCalculator;
  private slippageGuard: SlippageGuard;
  private wallet: ReturnType<typeof loadWallet>;
  private tokens: any;

  constructor(
    connection: Connection,
    ammProgram: Program,
    slippageGuard: SlippageGuard,
    tokens: any
  ) {
    this.connection = connection;
    this.ammProgram = ammProgram;
    this.feeCalculator = new FeeCalculator(connection);
    this.slippageGuard = slippageGuard;
    this.wallet = loadWallet();
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
    borrowDecimals: number
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

    const { blockhash } = await this.connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = this.wallet.publicKey;

    logger.info({
      instructions: transaction.instructions.length,
      flow: "borrow → swap × " + route.poolCount + " → repay",
    }, "Flash loan arb transaction built");

    return transaction;
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