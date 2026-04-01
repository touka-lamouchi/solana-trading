import { Connection, PublicKey } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet, BN } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { loadWallet } from "../../src/utils/wallet";
import { logger } from "../../src/utils/logger";
import fs from "fs";

const idl = JSON.parse(
  fs.readFileSync("programs-amm/target/idl/programs_amm.json", "utf-8")
);

const SCENARIOS: Record<string, { amount: number; description: string }> = {
  "arb-small": { amount: 5_000, description: "Small arb gap (~5%)" },
  "arb-large": { amount: 20_000, description: "Large arb gap (~20%)" },
  "arb-tiny": { amount: 500, description: "Tiny arb gap (~0.5%) — should be unprofitable" },
};

async function runSimulation(scenario: string) {
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const wallet = loadWallet();
  const provider = new AnchorProvider(connection, new Wallet(wallet), { commitment: "confirmed" });

  const program = new Program(idl, provider) as any;

  const pools = JSON.parse(fs.readFileSync("config/devnet_pools.json", "utf-8"));
  const tokens = JSON.parse(fs.readFileSync("config/devnet_tokens.json", "utf-8"));

  const config = SCENARIOS[scenario];
  if (!config) {
    logger.error(`Unknown scenario: ${scenario}`);
    logger.info(`Available scenarios: ${Object.keys(SCENARIOS).join(", ")}`);
    return;
  }

  logger.info({ scenario, description: config.description }, "Running simulation");

  const pool1 = pools.pool1;

  await program.methods
    .swap(
      new BN(config.amount * 10 ** 6),
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

  const v1a = await connection.getTokenAccountBalance(new PublicKey(pool1.tokenAVault));
  const v1b = await connection.getTokenAccountBalance(new PublicKey(pool1.tokenBVault));
  const price1 = parseFloat(v1a.value.uiAmountString!) / parseFloat(v1b.value.uiAmountString!);

  const v3a = await connection.getTokenAccountBalance(new PublicKey(pools.pool3.tokenAVault));
  const v3b = await connection.getTokenAccountBalance(new PublicKey(pools.pool3.tokenBVault));
  const price3 = parseFloat(v3a.value.uiAmountString!) / parseFloat(v3b.value.uiAmountString!);

  logger.info({
    pool1_price: price1.toFixed(4),
    pool3_price: price3.toFixed(4),
    gap_percent: (((price1 - price3) / price3) * 100).toFixed(2) + "%",
  }, "Price gap created");

  logger.info("=== Simulation complete ===");
}

const scenario = process.argv[2];
if (!scenario) {
  logger.info("Usage: npx tsx scripts/devnet/simulator.ts <scenario>");
  logger.info(`Available: ${Object.keys(SCENARIOS).join(", ")}`);
} else {
  runSimulation(scenario).catch(console.error);
}