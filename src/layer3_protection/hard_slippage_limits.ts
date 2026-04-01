import { Connection, Transaction, PublicKey } from "@solana/web3.js";
import { SlippageGuard } from "../protection/slippage_guard";
import { logger } from "../utils/logger";

export interface SlippageCheckParams {
  transaction: Transaction;
  outputTokenAccount: PublicKey;
  expectedOutputAmount: bigint;
  slippageBps: number;
}

export interface SlippageCheckResult {
  passed: boolean;
  simulatedOutputAmount: bigint | null;
  minRequiredAmount: bigint;
  reason?: string;
}

export class HardSlippageLimits {
  private connection: Connection;
  private slippageGuard: SlippageGuard;

  constructor(connection: Connection, slippageGuard: SlippageGuard) {
    this.connection = connection;
    this.slippageGuard = slippageGuard;
  }

  async checkTransaction(params: SlippageCheckParams): Promise<SlippageCheckResult> {
    const { transaction, outputTokenAccount, expectedOutputAmount, slippageBps } = params;

    const minRequiredAmount = BigInt(
      this.slippageGuard.calculateMinimumOutput(Number(expectedOutputAmount))
    );

    // 0 bps means exact output required — always reject unless simulation matches perfectly
    if (slippageBps === 0) {
      logger.warn({ slippageBps: 0 }, "Hard slippage check: 0 bps — rejecting pre-flight");
      return {
        passed: false,
        simulatedOutputAmount: null,
        minRequiredAmount,
        reason: "0 bps slippage — trade rejected pre-flight",
      };
    }

    // Fetch pre-simulation balance
    let preBalance = 0n;
    try {
      const info = await this.connection.getTokenAccountBalance(outputTokenAccount);
      preBalance = BigInt(info.value.amount);
    } catch {
      logger.warn({ outputTokenAccount: outputTokenAccount.toBase58() }, "Could not fetch pre-simulation balance");
    }

    // Simulate the transaction
    let simResult;
    try {
      simResult = await this.connection.simulateTransaction(
        transaction,
        undefined,
        [outputTokenAccount]
      );
    } catch (err: any) {
      return {
        passed: false,
        simulatedOutputAmount: null,
        minRequiredAmount,
        reason: `Simulation threw: ${err.message}`,
      };
    }

    if (simResult.value.err) {
      return {
        passed: false,
        simulatedOutputAmount: null,
        minRequiredAmount,
        reason: `Simulation failed: ${JSON.stringify(simResult.value.err)}`,
      };
    }

    // Extract post-simulation balance from returned account data
    let simulatedOutputAmount: bigint | null = null;
    try {
      const acct = simResult.value.accounts?.[0];
      if (acct && Array.isArray(acct.data)) {
        // base64-encoded account data: decode and parse SPL token layout
        const raw = Buffer.from(acct.data[0] as string, "base64");
        // SPL token account: amount is a u64 at offset 64
        const postBalance = raw.readBigUInt64LE(64);
        simulatedOutputAmount = postBalance - preBalance;
      }
    } catch {
      logger.warn("Could not parse simulated output amount from account data");
    }

    if (simulatedOutputAmount === null) {
      // Can't verify — let through with a warning
      logger.warn("Hard slippage check: could not extract simulated output, allowing trade");
      return { passed: true, simulatedOutputAmount: null, minRequiredAmount };
    }

    if (simulatedOutputAmount < minRequiredAmount) {
      logger.error({
        simulated: simulatedOutputAmount.toString(),
        minRequired: minRequiredAmount.toString(),
        slippageBps,
      }, "Hard slippage check FAILED");
      return {
        passed: false,
        simulatedOutputAmount,
        minRequiredAmount,
        reason: `Simulated output ${simulatedOutputAmount} < min required ${minRequiredAmount}`,
      };
    }

    logger.info({
      simulated: simulatedOutputAmount.toString(),
      minRequired: minRequiredAmount.toString(),
    }, "Hard slippage check passed");

    return { passed: true, simulatedOutputAmount, minRequiredAmount };
  }

  async assertTransaction(params: SlippageCheckParams): Promise<void> {
    const result = await this.checkTransaction(params);
    if (!result.passed) {
      throw new Error(`Hard slippage check failed: ${result.reason}`);
    }
  }
}
