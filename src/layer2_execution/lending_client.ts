/**
 * LendingClient — thin IDL wrapper for the programs-lending Anchor program.
 *
 * Loaded once per bot start from config/devnet_lending.json. Exposes:
 *   - buildLiquidateInstruction(): build a `liquidate` tx ready to submit
 *   - getProgram(): raw Anchor Program for getProgramAccounts / subscribe
 *   - derivePositionPda(): deterministic PDA for a given borrower + id
 */

import { Connection, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { BN } from "@coral-xyz/anchor";
import fs from "fs";
import path from "path";
import { logger } from "../utils/logger";

const LENDING_CONFIG_PATH = path.resolve(__dirname, "../../config/devnet_lending.json");

export interface LiquidateParams {
  positionPda: PublicKey;
  collateralMint: PublicKey;
  /** liquidator_collateral: token account that will receive the collateral */
  liquidatorCollateral: PublicKey;
  botPublicKey: PublicKey;
  /** collateral_price_bps = price_of_1_collateral_in_debt_units × 10_000 */
  collateralPriceBps: number;
}

export interface DecodedPosition {
  pda: PublicKey;
  borrower: PublicKey;
  collateralMint: PublicKey;
  debtMint: PublicKey;
  collateralVault: PublicKey;
  collateralAmount: bigint;
  debtAmount: bigint;
  thresholdBps: bigint;
  isLiquidated: boolean;
  bump: number;
  id: Uint8Array;
}

export class LendingClient {
  private program: Program;

  constructor(connection: Connection, signerWallet: { publicKey: PublicKey; signTransaction: any; signAllTransactions: any }) {
    if (!fs.existsSync(LENDING_CONFIG_PATH)) {
      throw new Error(
        `config/devnet_lending.json not found. Run 08_deploy_lending.ts after anchor deploy.`,
      );
    }
    const cfg = JSON.parse(fs.readFileSync(LENDING_CONFIG_PATH, "utf-8"));
    if (!cfg.idl) {
      throw new Error("config/devnet_lending.json has no IDL. Re-run 08_deploy_lending.ts after anchor build.");
    }
    const provider = new AnchorProvider(connection, signerWallet as any, { commitment: "confirmed" });
    // Patch the IDL address so Program uses the deployed program_id from config,
    // not whatever placeholder was baked into the IDL at build time.
    const idl = { ...cfg.idl, address: cfg.program_id };
    this.program = new Program(idl, provider);
  }

  get programId(): PublicKey {
    return this.program.programId;
  }

  getProgram(): Program {
    return this.program;
  }

  static derivePositionPda(
    borrower: PublicKey,
    id: Uint8Array,
    programId: PublicKey,
  ): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("loan_position"), borrower.toBuffer(), Buffer.from(id)],
      programId,
    );
  }

  async buildLiquidateTransaction(params: LiquidateParams): Promise<Transaction> {
    const ix = await (this.program as any).methods
      .liquidate(new BN(params.collateralPriceBps))
      .accounts({
        position: params.positionPda,
        collateralVault: getAssociatedTokenAddressSync(
          params.collateralMint,
          params.positionPda,
          true,
        ),
        liquidatorCollateral: params.liquidatorCollateral,
        bot: params.botPublicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    const tx = new Transaction().add(ix);
    return tx;
  }

  /** Fetch and decode all active (non-liquidated) positions. */
  async getActivePositions(): Promise<DecodedPosition[]> {
    const accounts = await this.program.provider.connection.getProgramAccounts(
      this.program.programId,
      { filters: [{ dataSize: 170 }] },
    );

    const results: DecodedPosition[] = [];
    for (const { pubkey, account } of accounts) {
      try {
        const pos = (this.program as any).coder.accounts.decode("loanPosition",account.data);
        if (pos.isLiquidated) continue;
        results.push({
          pda: pubkey,
          borrower: pos.borrower,
          collateralMint: pos.collateralMint,
          debtMint: pos.debtMint,
          collateralVault: pos.collateralVault,
          collateralAmount: BigInt(pos.collateralAmount.toString()),
          debtAmount: BigInt(pos.debtAmount.toString()),
          thresholdBps: BigInt(pos.thresholdBps.toString()),
          isLiquidated: pos.isLiquidated,
          bump: pos.bump,
          id: new Uint8Array(pos.id),
        });
      } catch (e: any) {
        logger.warn({ pda: pubkey.toBase58(), err: e.message }, "LendingClient: decode error");
      }
    }
    return results;
  }

  /** Decode a single raw account buffer into a DecodedPosition (for accountSubscribe callbacks). */
  decodePosition(pda: PublicKey, data: Buffer): DecodedPosition | null {
    try {
      const pos = (this.program as any).coder.accounts.decode("loanPosition",data);
      return {
        pda,
        borrower: pos.borrower,
        collateralMint: pos.collateralMint,
        debtMint: pos.debtMint,
        collateralVault: pos.collateralVault,
        collateralAmount: BigInt(pos.collateralAmount.toString()),
        debtAmount: BigInt(pos.debtAmount.toString()),
        thresholdBps: BigInt(pos.thresholdBps.toString()),
        isLiquidated: pos.isLiquidated,
        bump: pos.bump,
        id: new Uint8Array(pos.id),
      };
    } catch {
      return null;
    }
  }
}
