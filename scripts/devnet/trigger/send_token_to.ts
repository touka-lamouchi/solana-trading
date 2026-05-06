/**
 * Transfer any tracked devnet token (fUSDC, fSOL, fRAY) from the bot wallet
 * to a target recipient. Use this to seed Phantom wallets with multiple
 * token types so the bot can earn in different currencies.
 *
 * Usage:
 *   npx ts-node scripts/devnet/send_token_to.ts <token> <recipientPubkey> <amount>
 *
 * Examples:
 *   npx ts-node scripts/devnet/send_token_to.ts fUSDC G2J8...CUC7 1000
 *   npx ts-node scripts/devnet/send_token_to.ts fSOL  G2J8...CUC7 5
 *   npx ts-node scripts/devnet/send_token_to.ts fRAY  G2J8...CUC7 200
 *
 * Or seed all three at once with the helper flag:
 *   npx ts-node scripts/devnet/send_token_to.ts ALL G2J8...CUC7
 *   → sends 1000 fUSDC, 5 fSOL, 200 fRAY (default amounts)
 *
 * NOTE: Mint authorities were permanently revoked on these synthetic devnet
 * tokens, so this transfers from the bot wallet's existing supply (it minted
 * everything before revoke_mint.ts).
 */

import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, transfer } from "@solana/spl-token";
import fs from "fs";
import { loadWallet } from "../../../src/utils/wallet";
import { getConfig } from "../../../src/utils/config";
import { logger } from "../../../src/utils/logger";

const ALL_DEFAULTS: Record<string, number> = { fUSDC: 1000, fSOL: 5, fRAY: 200 };

async function sendOne(
  connection: Connection,
  sender: Keypair,
  recipient: PublicKey,
  tokenName: string,
  amount: number,
  tokens: any,
): Promise<void> {
  const tokenKey = Object.keys(tokens).find((k) => tokens[k].name === tokenName);
  if (!tokenKey) throw new Error(`Unknown token "${tokenName}". Known: fUSDC, fSOL, fRAY`);
  const t = tokens[tokenKey];
  const mint = new PublicKey(t.mint);
  const rawAmount = BigInt(Math.round(amount * 10 ** t.decimals));

  const senderAta = await getOrCreateAssociatedTokenAccount(connection, sender, mint, sender.publicKey);
  const senderBalRaw = await connection.getTokenAccountBalance(senderAta.address);
  const senderUi = parseFloat(senderBalRaw.value.uiAmountString ?? "0");
  if (senderUi < amount) {
    throw new Error(`Bot wallet has only ${senderUi} ${tokenName}, needs ${amount}`);
  }

  const recipientAta = await getOrCreateAssociatedTokenAccount(connection, sender, mint, recipient);

  const sig = await transfer(
    connection, sender,
    senderAta.address, recipientAta.address,
    sender, rawAmount,
  );

  logger.info({
    token: tokenName,
    amount,
    recipient: recipient.toBase58(),
    signature: sig,
    explorer: `https://explorer.solana.com/tx/${sig}?cluster=devnet`,
  }, `Sent ${amount} ${tokenName}`);
}

async function main() {
  const tokenArg = process.argv[2];
  const recipientArg = process.argv[3];
  const amountArg = process.argv[4];

  if (!tokenArg || !recipientArg) {
    console.error("Usage: npx ts-node scripts/devnet/send_token_to.ts <token|ALL> <recipientPubkey> [<amount>]");
    process.exit(1);
  }

  const config = getConfig();
  const sender = loadWallet();
  const connection = new Connection(config.network.rpc_url, "confirmed");
  const recipient = new PublicKey(recipientArg);
  const tokens = JSON.parse(fs.readFileSync("config/devnet_tokens.json", "utf-8"));

  if (tokenArg.toUpperCase() === "ALL") {
    for (const [name, amt] of Object.entries(ALL_DEFAULTS)) {
      try { await sendOne(connection, sender, recipient, name, amt, tokens); }
      catch (e: any) { logger.error({ token: name, error: e.message }, "Send failed for token"); }
    }
    return;
  }

  const amount = parseFloat(amountArg ?? "");
  if (!isFinite(amount) || amount <= 0) {
    console.error("Amount must be a positive number (or use ALL for defaults)");
    process.exit(1);
  }
  await sendOne(connection, sender, recipient, tokenArg, amount, tokens);
}

main().catch((err) => {
  logger.error({ err: err.message || err }, "send_token_to failed");
  process.exit(1);
});
