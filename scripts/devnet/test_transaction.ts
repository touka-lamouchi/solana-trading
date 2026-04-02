import { Connection, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { loadWallet } from "../../src/utils/wallet";
import { logger } from "../../src/utils/logger";
import { getConfig } from "../../src/utils/config";

async function testTransaction() {
  const cfg = getConfig();
  const connection = new Connection(cfg.network.rpc_url, {
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
  logger.info(`View on explorer: ${cfg.network.explorer_url}/tx/${signature}?cluster=${cfg.network.cluster}`);
}

testTransaction().catch(console.error);
