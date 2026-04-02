/**
 * Creates a dirty pool: dirty1 (mint authority active) paired with fUSDC.
 * This pool exists so the e2e test can DISCOVER an opportunity on it naturally,
 * then reject it when the safety pipeline catches dirty1's active mint authority.
 */

import { Connection, PublicKey, SystemProgram, Keypair } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { Program, AnchorProvider, Wallet, web3, BN } from "@coral-xyz/anchor";
import { loadWallet } from "../../src/utils/wallet";
import { logger } from "../../src/utils/logger";
import fs from "fs";

const idl = JSON.parse(
  fs.readFileSync("programs-amm/target/idl/programs_amm.json", "utf-8")
);

async function createDirtyPool() {
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const wallet = loadWallet();
  const provider = new AnchorProvider(connection, new Wallet(wallet), { commitment: "confirmed" });

  const programId = new PublicKey("CzpMFPxKuL2qSXiZUGmYEdY6LSbD1zdmK25ZNpjukR9K");
  const program = new Program(idl, provider) as any;

  const dirty  = JSON.parse(fs.readFileSync("config/devnet_dirty_tokens.json", "utf-8"));
  const tokens = JSON.parse(fs.readFileSync("config/devnet_tokens.json", "utf-8"));

  const dirtyMint = new PublicKey(dirty.dirty1_mint_authority.mint);
  const fUSDCMint = new PublicKey(tokens.tokenA.mint);

  // 1. Create token account for dirty1 and mint tokens
  logger.info("Creating dirty1 token account and minting...");
  const dirtyAccount = await getOrCreateAssociatedTokenAccount(
    connection, wallet, dirtyMint, wallet.publicKey
  );
  await mintTo(connection, wallet, dirtyMint, dirtyAccount.address, wallet, 500_000 * 10 ** 6);
  logger.info({ account: dirtyAccount.address.toBase58() }, "Dirty1 tokens minted: 500,000");

  // 2. Create pool: dirty1/fUSDC (seed 7)
  const seed = 7;
  const [poolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), wallet.publicKey.toBuffer(), Buffer.from([seed])],
    programId
  );

  const vaultA = Keypair.generate();
  const vaultB = Keypair.generate();

  logger.info("Creating dirty pool: dirty1/fUSDC...");
  await program.methods
    .initializePool(seed)
    .accounts({
      pool: poolPda,
      tokenAMint: dirtyMint,
      tokenBMint: fUSDCMint,
      tokenAVault: vaultA.publicKey,
      tokenBVault: vaultB.publicKey,
      authority: wallet.publicKey,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      rent: web3.SYSVAR_RENT_PUBKEY,
    })
    .signers([vaultA, vaultB])
    .rpc();

  logger.info({ pool: poolPda.toBase58() }, "Dirty pool created");

  // 3. Add liquidity with skewed pricing
  // Cheap dirty1: 100,000 dirty1 + 10,000 fUSDC → 1 dirty1 = 0.1 fUSDC
  // This makes dirty1 look like it has value and could be arbitraged
  await program.methods
    .addLiquidity(
      new BN(100_000 * 10 ** 6),  // 100k dirty1
      new BN(10_000 * 10 ** 6)    // 10k fUSDC
    )
    .accounts({
      pool: poolPda,
      tokenAVault: vaultA.publicKey,
      tokenBVault: vaultB.publicKey,
      userTokenA: dirtyAccount.address,
      userTokenB: new PublicKey(tokens.tokenA.account),
      user: wallet.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  logger.info("Dirty pool liquidity added: 100,000 dirty1 + 10,000 fUSDC");

  // 4. Save pool4 to devnet_pools.json
  const pools = JSON.parse(fs.readFileSync("config/devnet_pools.json", "utf-8"));
  pools.pool4_dirty = {
    name: "dirty1/fUSDC",
    address: poolPda.toBase58(),
    tokenAVault: vaultA.publicKey.toBase58(),
    tokenBVault: vaultB.publicKey.toBase58(),
    tokenA: "dirty1",
    tokenB: "fUSDC",
    tokenAMint: dirtyMint.toBase58(),
    tokenBMint: fUSDCMint.toBase58(),
    dirty: true,
  };
  fs.writeFileSync("config/devnet_pools.json", JSON.stringify(pools, null, 2));

  // Also update dirty tokens config with the account
  dirty.dirty1_mint_authority.account = dirtyAccount.address.toBase58();
  fs.writeFileSync("config/devnet_dirty_tokens.json", JSON.stringify(dirty, null, 2));

  logger.info("Pool config updated with pool4_dirty");
  logger.info("=== Dirty pool created successfully ===");
}

createDirtyPool().catch(console.error);
