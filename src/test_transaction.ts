import { Connection, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { loadWallet } from "./utils/wallet";
import { logger } from "./utils/logger";

async function testTransaction() {
  const connection = new Connection("https://api.devnet.solana.com", {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 60000,
  });
  const wallet = loadWallet();

  logger.info({ pubkey: wallet.publicKey.toBase58() }, "Wallet loaded");

  const balance = await connection.getBalance(wallet.publicKey);
  logger.info({ balance: balance / LAMPORTS_PER_SOL }, "Current balance (SOL)");

  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: wallet.publicKey,
      lamports: 0.001 * LAMPORTS_PER_SOL,
    })
  );

  logger.info("Sending transaction...");
  const signature = await sendAndConfirmTransaction(connection, transaction, [wallet]);

  logger.info({ signature }, "Transaction confirmed!");
  logger.info(`View on explorer: https://explorer.solana.com/tx/${signature}?cluster=devnet`);
}

testTransaction().catch(console.error);