/**
 * register_position.ts — On-chain loan position registration.
 *
 * Replaces create_loan.ts (Redis-based). This script calls the programs-lending
 * Anchor program to register a real on-chain position. The borrower deposits
 * collateral into a PDA-owned vault; debt is recorded on-chain.
 *
 * Usage:
 *   npx ts-node scripts/devnet/trigger/register_position.ts \
 *     --collateralToken=fSOL --collateralAmount=5 \
 *     --debtToken=fUSDC  --debtAmount=800 \
 *     --threshold=1.20
 *
 *   npx ts-node scripts/devnet/trigger/register_position.ts --list
 *
 * How it works:
 *   1. Loads the lending program IDL from config/devnet_lending.json
 *   2. Calls register_position(id, collateral_amount, debt_amount, threshold_bps)
 *   3. Transfers collateral from the bot wallet's ATA into the position's vault ATA
 *
 * To trigger a liquidation:
 *   Create a position where health is near the threshold, then push the pool
 *   price the wrong way with create_arb.ts:
 *     --collateralAmount=5 (fSOL) --debtAmount=850 --threshold=1.20
 *   Pool price: 1 fSOL ≈ 170 fUSDC → health = (5×170)/(850×1) = 1.00 → liquidatable
 */

import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet, BN } from "@coral-xyz/anchor";
import {
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import fs from "fs";
import path from "path";
import { loadWallet } from "../../../src/utils/wallet";
import { getConfig } from "../../../src/utils/config";
import { logger } from "../../../src/utils/logger";

const ROOT = path.resolve(__dirname, "../../..");
const LENDING_CONFIG_PATH = path.join(ROOT, "config", "devnet_lending.json");
const TOKENS_PATH = path.join(ROOT, "config", "devnet_tokens.json");

interface Args {
  collateralToken?: string;
  collateralAmount?: number;
  debtToken?: string;
  debtAmount?: number;
  threshold?: number;
  list?: boolean;
}

function parseArgs(): Args {
  const out: Args = {};
  for (const arg of process.argv.slice(2)) {
    const [k, v] = arg.replace(/^--/, "").split("=");
    if (k === "list") out.list = true;
    else if (k === "collateralToken") out.collateralToken = v ?? "";
    else if (k === "debtToken") out.debtToken = v ?? "";
    else if (k === "collateralAmount") out.collateralAmount = parseFloat(v!);
    else if (k === "debtAmount") out.debtAmount = parseFloat(v!);
    else if (k === "threshold") out.threshold = parseFloat(v!);
  }
  return out;
}

function loadLendingConfig(): { program_id: string; idl: any } {
  if (!fs.existsSync(LENDING_CONFIG_PATH)) {
    throw new Error(
      `config/devnet_lending.json not found.\n` +
      `Run: cd programs-lending && anchor build && anchor deploy --provider.cluster devnet\n` +
      `Then: npx ts-node scripts/devnet/setup/08_deploy_lending.ts`,
    );
  }
  return JSON.parse(fs.readFileSync(LENDING_CONFIG_PATH, "utf-8"));
}

function loadTokens(): Record<string, { name: string; mint: string; decimals: number }> {
  return JSON.parse(fs.readFileSync(TOKENS_PATH, "utf-8"));
}

function findToken(
  tokens: Record<string, { name: string; mint: string; decimals: number }>,
  name: string,
): { mint: string; decimals: number } {
  const entry = Object.values(tokens).find(t => t.name === name);
  if (!entry) throw new Error(`Token "${name}" not found in devnet_tokens.json`);
  return entry;
}

async function listPositions(
  connection: Connection,
  program: Program,
): Promise<void> {
  const accounts = await connection.getProgramAccounts(program.programId, {
    filters: [{ dataSize: 170 }],
  });

  if (accounts.length === 0) {
    logger.info("No loan positions on-chain.");
    return;
  }

  for (const { pubkey, account } of accounts) {
    try {
      const pos = program.coder.accounts.decode("LoanPosition", account.data);
      logger.info(
        {
          pda: pubkey.toBase58(),
          borrower: pos.borrower.toBase58(),
          collateralAmount: pos.collateralAmount.toString(),
          debtAmount: pos.debtAmount.toString(),
          thresholdBps: pos.thresholdBps.toString(),
          isLiquidated: pos.isLiquidated,
          id: Buffer.from(pos.id).toString("hex"),
        },
        "LoanPosition",
      );
    } catch {
      logger.warn({ pda: pubkey.toBase58() }, "Could not decode account");
    }
  }
}

async function main() {
  const args = parseArgs();
  const config = getConfig();

  const lendingConfig = loadLendingConfig();
  const tokens = loadTokens();
  const wallet = loadWallet();

  const rpcUrl = (config as any).network?.devnet_rpc ?? "https://api.devnet.solana.com";
  const connection = new Connection(rpcUrl, "confirmed");
  const provider = new AnchorProvider(connection, new Wallet(wallet), {
    commitment: "confirmed",
  });

  const program = new Program(lendingConfig.idl, new PublicKey(lendingConfig.program_id), provider);

  if (args.list) {
    await listPositions(connection, program as any);
    return;
  }

  const required = ["collateralToken", "collateralAmount", "debtToken", "debtAmount", "threshold"];
  for (const r of required) {
    if (!(r in args) || (args as any)[r] === undefined) {
      console.error(`Missing --${r}`);
      console.error("Required: --collateralToken --collateralAmount --debtToken --debtAmount --threshold");
      process.exit(1);
    }
  }

  const collateralInfo = findToken(tokens, args.collateralToken!);
  const debtInfo = findToken(tokens, args.debtToken!);

  const collateralMint = new PublicKey(collateralInfo.mint);
  const debtMint = new PublicKey(debtInfo.mint);

  // Generate a random 8-byte ID for this position.
  const id = Array.from({ length: 8 }, () => Math.floor(Math.random() * 256));
  const idBytes = Buffer.from(id);

  // Scale collateral amount to raw units (integer, with decimals).
  const collateralRaw = Math.round(args.collateralAmount! * Math.pow(10, collateralInfo.decimals));
  const debtRaw = Math.round(args.debtAmount! * Math.pow(10, debtInfo.decimals));

  // threshold_bps: threshold × 10_000  (e.g. 1.20 → 12000)
  const thresholdBps = Math.round(args.threshold! * 10_000);

  // Derive position PDA.
  const [positionPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("loan_position"), wallet.publicKey.toBuffer(), idBytes],
    program.programId,
  );

  // Ensure borrower's collateral ATA exists.
  const borrowerCollateral = await getOrCreateAssociatedTokenAccount(
    connection,
    wallet,
    collateralMint,
    wallet.publicKey,
  );

  logger.info(
    {
      positionPda: positionPda.toBase58(),
      collateralToken: args.collateralToken,
      collateralRaw,
      debtToken: args.debtToken,
      debtRaw,
      thresholdBps,
      id: idBytes.toString("hex"),
    },
    "Registering on-chain position...",
  );

  const tx = await (program as any).methods
    .registerPosition(
      Array.from(idBytes),
      new BN(collateralRaw),
      new BN(debtRaw),
      new BN(thresholdBps),
    )
    .accounts({
      position: positionPda,
      borrowerCollateral: borrowerCollateral.address,
      collateralMint,
      debtMint,
      borrower: wallet.publicKey,
    })
    .rpc({ commitment: "confirmed" });

  logger.info(
    {
      signature: tx,
      positionPda: positionPda.toBase58(),
      id: idBytes.toString("hex"),
    },
    "Position registered on-chain.",
  );

  console.log(`\nExplorer: https://explorer.solana.com/tx/${tx}?cluster=devnet`);
  console.log(`Position PDA: ${positionPda.toBase58()}`);
  console.log(`ID (hex): ${idBytes.toString("hex")}`);
}

main().catch(e => {
  logger.error({ err: e.message ?? e }, "register_position failed");
  process.exit(1);
});
