/**
 * Manually create a real arbitrage opportunity on devnet by pushing one of
 * your pools out of equilibrium with the other two.
 *
 * Usage:
 *   npx ts-node scripts/devnet/create_arb.ts <pool> <amountFusdc>
 *
 *   pool        : pool1 | pool2 | pool3   (default: pool1)
 *   amountFusdc : how much fUSDC to swap to create the gap (default: 5000)
 *
 * Examples:
 *   npx ts-node scripts/devnet/create_arb.ts                # 5000 into pool1
 *   npx ts-node scripts/devnet/create_arb.ts pool1 8000     # bigger gap
 *   npx ts-node scripts/devnet/create_arb.ts pool3 3000     # gap on a different pool
 *
 * The running bot will detect the resulting triangular arb on its next tick
 * (within ~10s) and execute it via flash loan, restoring equilibrium and
 * pocketing the profit into your vault.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet, BN } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import fs from "fs";
import { loadWallet } from "../../../src/utils/wallet";
import { getConfig } from "../../../src/utils/config";
import { logger } from "../../../src/utils/logger";

async function main() {
  const args = process.argv.slice(2);
  const reverse = args.includes("--reverse") || args.includes("-r");
  const positional = args.filter(a => !a.startsWith("-"));
  const poolKey = positional[0] || "pool1";
  const amountIn = parseFloat(positional[1] || "5000");

  if (!["pool1", "pool2", "pool3"].includes(poolKey)) {
    console.error("pool must be one of: pool1 pool2 pool3");
    process.exit(1);
  }

  const cfg = getConfig();
  const wallet = loadWallet();
  const connection = new Connection(cfg.network.rpc_url, "confirmed");
  const provider = new AnchorProvider(connection, new Wallet(wallet), { commitment: "confirmed" });

  const ammIdl = JSON.parse(fs.readFileSync("programs-amm/target/idl/programs_amm.json", "utf-8"));
  const ammProgram = new Program(ammIdl, provider) as any;

  const pools = JSON.parse(fs.readFileSync("config/devnet_pools.json", "utf-8"));
  const tokens = JSON.parse(fs.readFileSync("config/devnet_tokens.json", "utf-8"));
  const pool = pools[poolKey];

  // Resolve which token we're spending. Default: tokenA (fUSDC). With --reverse,
  // spend tokenB of this pool (e.g. fSOL for pool1). Useful when bot wallet is
  // out of fUSDC but flush with fSOL/fRAY.
  const tokenBKeyForPool = Object.keys(tokens).find((k) => tokens[k].name === pool.tokenB);
  if (!tokenBKeyForPool) throw new Error(`Token entry for ${pool.tokenB} not found`);
  const spendingToken = reverse ? tokens[tokenBKeyForPool] : tokens.tokenA;
  const decimalsSpending = spendingToken.decimals;
  const amountInRaw = new BN(Math.floor(amountIn * 10 ** decimalsSpending));

  // Read pool reserves before
  const balABefore = await connection.getTokenAccountBalance(new PublicKey(pool.tokenAVault));
  const balBBefore = await connection.getTokenAccountBalance(new PublicKey(pool.tokenBVault));
  const priceBefore = parseFloat(balABefore.value.uiAmountString!) / parseFloat(balBBefore.value.uiAmountString!);

  logger.info({
    pool: poolKey,
    pair: pool.name,
    reserveA: balABefore.value.uiAmountString,
    reserveB: balBBefore.value.uiAmountString,
    price: priceBefore.toFixed(4),
  }, "Pool state BEFORE");

  const fromName = reverse ? pool.tokenB : tokens.tokenA.name;
  const toName = reverse ? tokens.tokenA.name : pool.tokenB;
  logger.info({ swapping: `${amountIn} ${fromName} → ${toName}`, direction: reverse ? "B→A" : "A→B" },
    "Pushing pool out of equilibrium...");

  // Get the user's token accounts dynamically (account config holds them)
  const userTokenA = new PublicKey(tokens.tokenA.account);
  const userTokenB = new PublicKey(tokens[tokenBKeyForPool].account);

  const sig = await ammProgram.methods
    .swap(amountInRaw, new BN(1), !reverse) // a_to_b: false when --reverse
    .accounts({
      pool: new PublicKey(pool.address),
      tokenAVault: new PublicKey(pool.tokenAVault),
      tokenBVault: new PublicKey(pool.tokenBVault),
      userTokenA, userTokenB,
      user: wallet.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  await connection.confirmTransaction(sig, "confirmed");

  const balAAfter = await connection.getTokenAccountBalance(new PublicKey(pool.tokenAVault));
  const balBAfter = await connection.getTokenAccountBalance(new PublicKey(pool.tokenBVault));
  const priceAfter = parseFloat(balAAfter.value.uiAmountString!) / parseFloat(balBAfter.value.uiAmountString!);

  logger.info({
    pool: poolKey,
    reserveA: balAAfter.value.uiAmountString,
    reserveB: balBAfter.value.uiAmountString,
    price: priceAfter.toFixed(4),
    drift: `${(((priceAfter - priceBefore) / priceBefore) * 100).toFixed(2)}%`,
    signature: sig,
    explorer: `https://explorer.solana.com/tx/${sig}?cluster=devnet`,
  }, "Pool state AFTER — arb opportunity created");

  logger.info("Bot should detect and execute on its next tick (within ~10s).");
}

main().catch((err) => {
  logger.error({ err: err.message || err }, "create_arb failed");
  process.exit(1);
});
