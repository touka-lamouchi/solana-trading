import { Connection, PublicKey } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet, BN } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { loadWallet } from "../../src/utils/wallet";
import { logger } from "../../src/utils/logger";
import fs from "fs";

const idl = JSON.parse(
  fs.readFileSync("programs-amm/target/idl/programs_amm.json", "utf-8")
);

async function testSwap() {
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const wallet = loadWallet();
  const provider = new AnchorProvider(connection, new Wallet(wallet), { commitment: "confirmed" });

  const program = new Program(idl, provider) as any;

  const pools = JSON.parse(fs.readFileSync("config/devnet_pools.json", "utf-8"));
  const tokens = JSON.parse(fs.readFileSync("config/devnet_tokens.json", "utf-8"));

  const pool1 = pools.pool1;

  const beforeA = await connection.getTokenAccountBalance(new PublicKey(tokens.tokenA.account));
  const beforeB = await connection.getTokenAccountBalance(new PublicKey(tokens.tokenB.account));
  logger.info({ fUSDC: beforeA.value.uiAmountString, fSOL: beforeB.value.uiAmountString }, "Before swap");

  logger.info("Swapping 100 fUSDC for fSOL on Pool 1...");

  await program.methods
    .swap(
      new BN(100 * 10 ** 6),
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

  const afterA = await connection.getTokenAccountBalance(new PublicKey(tokens.tokenA.account));
  const afterB = await connection.getTokenAccountBalance(new PublicKey(tokens.tokenB.account));
  logger.info({ fUSDC: afterA.value.uiAmountString, fSOL: afterB.value.uiAmountString }, "After swap");

  logger.info("=== Swap successful! AMM is working ===");
}

testSwap().catch(console.error);