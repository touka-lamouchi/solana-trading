import { Connection, PublicKey, SystemProgram, Keypair } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Program, AnchorProvider, Wallet, web3, BN } from "@coral-xyz/anchor";
import { loadWallet } from "../../src/utils/wallet";
import { logger } from "../../src/utils/logger";
import fs from "fs";

const idl = JSON.parse(
  fs.readFileSync("programs-amm/target/idl/programs_amm.json", "utf-8")
);

async function createPools() {
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const wallet = loadWallet();
  const provider = new AnchorProvider(
    connection,
    new Wallet(wallet),
    { commitment: "confirmed" }
  );

  const programId = new PublicKey("CzpMFPxKuL2qSXiZUGmYEdY6LSbD1zdmK25ZNpjukR9K");
  const program = new Program(idl, provider) as any;

  const tokens = JSON.parse(fs.readFileSync("config/devnet_tokens.json", "utf-8"));

  const tokenAMint = new PublicKey(tokens.tokenA.mint);
  const tokenBMint = new PublicKey(tokens.tokenB.mint);
  const tokenCMint = new PublicKey(tokens.tokenC.mint);

  // === POOL 1: fUSDC / fSOL ===
  logger.info("Creating Pool 1: fUSDC / fSOL...");

  const seed1 = 4;
  const [pool1Pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), wallet.publicKey.toBuffer(), Buffer.from([seed1])],
    programId
  );

  const vault1A = Keypair.generate();
  const vault1B = Keypair.generate();

  await program.methods
    .initializePool(seed1)
    .accounts({
      pool: pool1Pda,
      tokenAMint: tokenAMint,
      tokenBMint: tokenBMint,
      tokenAVault: vault1A.publicKey,
      tokenBVault: vault1B.publicKey,
      authority: wallet.publicKey,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      rent: web3.SYSVAR_RENT_PUBKEY,
    })
    .signers([vault1A, vault1B])
    .rpc();

  logger.info({ pool: pool1Pda.toBase58() }, "Pool 1 created");

  const userTokenA = new PublicKey(tokens.tokenA.account);
  const userTokenB = new PublicKey(tokens.tokenB.account);

  await program.methods
    .addLiquidity(
      new BN(100_000 * 10 ** 6),
      new BN(1_000 * 10 ** 9)
    )
    .accounts({
      pool: pool1Pda,
      tokenAVault: vault1A.publicKey,
      tokenBVault: vault1B.publicKey,
      userTokenA: userTokenA,
      userTokenB: userTokenB,
      user: wallet.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  logger.info("Pool 1 liquidity added: 100,000 fUSDC + 1,000 fSOL");

  // === POOL 2: fSOL / fRAY ===
  logger.info("Creating Pool 2: fSOL / fRAY...");

  const seed2 = 5;
  const [pool2Pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), wallet.publicKey.toBuffer(), Buffer.from([seed2])],
    programId
  );

  const vault2A = Keypair.generate();
  const vault2B = Keypair.generate();

  const userTokenC = new PublicKey(tokens.tokenC.account);

  await program.methods
    .initializePool(seed2)
    .accounts({
      pool: pool2Pda,
      tokenAMint: tokenBMint,
      tokenBMint: tokenCMint,
      tokenAVault: vault2A.publicKey,
      tokenBVault: vault2B.publicKey,
      authority: wallet.publicKey,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      rent: web3.SYSVAR_RENT_PUBKEY,
    })
    .signers([vault2A, vault2B])
    .rpc();

  logger.info({ pool: pool2Pda.toBase58() }, "Pool 2 created");

  await program.methods
    .addLiquidity(
      new BN(500 * 10 ** 9),
      new BN(250_000 * 10 ** 6)
    )
    .accounts({
      pool: pool2Pda,
      tokenAVault: vault2A.publicKey,
      tokenBVault: vault2B.publicKey,
      userTokenA: userTokenB,
      userTokenB: userTokenC,
      user: wallet.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  logger.info("Pool 2 liquidity added: 500 fSOL + 250,000 fRAY");

  // === POOL 3: fUSDC / fRAY ===
  logger.info("Creating Pool 3: fUSDC / fRAY...");

  const seed3 = 6;
  const [pool3Pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), wallet.publicKey.toBuffer(), Buffer.from([seed3])],
    programId
  );

  const vault3A = Keypair.generate();
  const vault3B = Keypair.generate();

  await program.methods
    .initializePool(seed3)
    .accounts({
      pool: pool3Pda,
      tokenAMint: tokenAMint,
      tokenBMint: tokenCMint,
      tokenAVault: vault3A.publicKey,
      tokenBVault: vault3B.publicKey,
      authority: wallet.publicKey,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      rent: web3.SYSVAR_RENT_PUBKEY,
    })
    .signers([vault3A, vault3B])
    .rpc();

  logger.info({ pool: pool3Pda.toBase58() }, "Pool 3 created");

  await program.methods
    .addLiquidity(
      new BN(50_000 * 10 ** 6),
      new BN(250_000 * 10 ** 6)
    )
    .accounts({
      pool: pool3Pda,
      tokenAVault: vault3A.publicKey,
      tokenBVault: vault3B.publicKey,
      userTokenA: userTokenA,
      userTokenB: userTokenC,
      user: wallet.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  logger.info("Pool 3 liquidity added: 50,000 fUSDC + 250,000 fRAY");

  const poolConfig = {
    pool1: {
      name: "fUSDC/fSOL",
      address: pool1Pda.toBase58(),
      tokenAVault: vault1A.publicKey.toBase58(),
      tokenBVault: vault1B.publicKey.toBase58(),
      tokenA: "fUSDC",
      tokenB: "fSOL",
    },
    pool2: {
      name: "fSOL/fRAY",
      address: pool2Pda.toBase58(),
      tokenAVault: vault2A.publicKey.toBase58(),
      tokenBVault: vault2B.publicKey.toBase58(),
      tokenA: "fSOL",
      tokenB: "fRAY",
    },
    pool3: {
      name: "fUSDC/fRAY",
      address: pool3Pda.toBase58(),
      tokenAVault: vault3A.publicKey.toBase58(),
      tokenBVault: vault3B.publicKey.toBase58(),
      tokenA: "fUSDC",
      tokenB: "fRAY",
    },
  };

  fs.writeFileSync(
    "config/devnet_pools.json",
    JSON.stringify(poolConfig, null, 2)
  );

  logger.info("Pool config saved to config/devnet_pools.json");
  logger.info("=== All pools created successfully ===");
}

createPools().catch(console.error);