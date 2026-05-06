/**
 * Send devnet fUSDC from the bot wallet to a target Phantom wallet.
 *
 * Usage:
 *   npx ts-node scripts/devnet/mint_fusdc_to.ts <recipientPubkey> <amount>
 *
 * Example:
 *   npx ts-node scripts/devnet/mint_fusdc_to.ts G2J8...CUC7 1000
 *
 * NOTE: The mint authority for fUSDC was permanently revoked by revoke_mint.ts,
 * so we can't actually mint new tokens. Instead we transfer from the bot wallet's
 * existing supply (it minted everything before the revoke). Creates the recipient
 * ATA if it doesn't exist.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  transfer,
} from "@solana/spl-token";
import fs from "fs";
import { loadWallet } from "../../../src/utils/wallet";
import { getConfig } from "../../../src/utils/config";
import { logger } from "../../../src/utils/logger";

async function main() {
  const recipientArg = process.argv[2];
  const amountArg = process.argv[3];

  if (!recipientArg || !amountArg) {
    console.error("Usage: npx ts-node scripts/devnet/mint_fusdc_to.ts <recipientPubkey> <amount>");
    process.exit(1);
  }

  const recipient = new PublicKey(recipientArg);
  const amount = parseFloat(amountArg);
  if (!isFinite(amount) || amount <= 0) {
    console.error("Amount must be a positive number");
    process.exit(1);
  }

  const config = getConfig();
  const sender = loadWallet(); // bot wallet — holds the original fUSDC supply
  const connection = new Connection(config.network.rpc_url, "confirmed");

  const tokens = JSON.parse(fs.readFileSync("config/devnet_tokens.json", "utf-8"));
  const fusdcMint = new PublicKey(tokens.tokenA.mint);
  const decimals = tokens.tokenA.decimals;
  const rawAmount = BigInt(Math.round(amount * 10 ** decimals));

  logger.info({
    sender: sender.publicKey.toBase58(),
    recipient: recipient.toBase58(),
    amount,
    mint: fusdcMint.toBase58(),
  }, "Transferring devnet fUSDC");

  const senderAta = await getOrCreateAssociatedTokenAccount(
    connection,
    sender,
    fusdcMint,
    sender.publicKey,
  );

  const senderBal = await connection.getTokenAccountBalance(senderAta.address);
  const senderUi = parseFloat(senderBal.value.uiAmountString ?? "0");
  logger.info({ senderBalance: senderUi, senderAta: senderAta.address.toBase58() }, "Sender ATA");
  if (senderUi < amount) {
    logger.error({ have: senderUi, need: amount }, "Bot wallet doesn't have enough fUSDC");
    process.exit(1);
  }

  const recipientAta = await getOrCreateAssociatedTokenAccount(
    connection,
    sender,
    fusdcMint,
    recipient,
  );
  logger.info({ recipientAta: recipientAta.address.toBase58() }, "Recipient ATA");

  const sig = await transfer(
    connection,
    sender,
    senderAta.address,
    recipientAta.address,
    sender,
    rawAmount,
  );

  logger.info({
    signature: sig,
    explorer: `https://explorer.solana.com/tx/${sig}?cluster=devnet`,
  }, `Transferred ${amount} fUSDC to ${recipient.toBase58()}`);
}

main().catch((err) => {
  logger.error({ err: err.message || err }, "Transfer failed");
  process.exit(1);
});
