import { Connection, PublicKey } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet, BN } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { loadWallet } from "../../src/utils/wallet";
import { logger } from "../../src/utils/logger";
import fs from "fs";

const idl = JSON.parse(
  fs.readFileSync("programs-amm/target/idl/programs_amm.json", "utf-8")
);

async function simulateArbOpportunity() {
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const wallet = loadWallet();
  const provider = new AnchorProvider(connection, new Wallet(wallet), { commitment: "confirmed" });

  const program = new Program(idl, provider) as any;

  const pools = JSON.parse(fs.readFileSync("config/devnet_pools.json", "utf-8"));
  const tokens = JSON.parse(fs.readFileSync("config/devnet_tokens.json", "utf-8"));

  logger.info("=== Creating arbitrage opportunity ===");
  logger.info("Buying 10,000 fUSDC worth of fSOL on Pool 1 to move the price...");

  const pool1 = pools.pool1;

  await program.methods
    .swap(
      new BN(10_000 * 10 ** 6),
      new BN(1),
      true
    )
    .accounts({
      pool: new PublicKey(pool1.address),
      tokenAVault: new PublicKey(pool1.tokenAVault),
      tokenBVault: new PublicKey(pool1.tokenBVault),
      userTokenA: new PublicKey(tokens.tokenA.account),
      userTokenB: new PublicKey(tokens.tokenB.account),
      user: wallet.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  const vaultA = await connection.getTokenAccountBalance(new PublicKey(pool1.tokenAVault));
  const vaultB = await connection.getTokenAccountBalance(new PublicKey(pool1.tokenBVault));
  const pricePool1 = parseFloat(vaultA.value.uiAmountString!) / parseFloat(vaultB.value.uiAmountString!);

  logger.info({
    pool1_fUSDC: vaultA.value.uiAmountString,
    pool1_fSOL: vaultB.value.uiAmountString,
    price_fSOL_in_fUSDC: pricePool1.toFixed(2),
  }, "Pool 1 price moved");

  const vault3A = await connection.getTokenAccountBalance(new PublicKey(pools.pool3.tokenAVault));
  const vault3B = await connection.getTokenAccountBalance(new PublicKey(pools.pool3.tokenBVault));

  logger.info({
    pool3_fUSDC: vault3A.value.uiAmountString,
    pool3_fRAY: vault3B.value.uiAmountString,
  }, "Pool 3 unchanged — price gap exists");

  logger.info("=== Arbitrage opportunity created ===");
}

simulateArbOpportunity().catch(console.error);