import { Connection, PublicKey } from "@solana/web3.js";
import { setAuthority, AuthorityType } from "@solana/spl-token";
import { loadWallet } from "../../src/utils/wallet";
import { logger } from "../../src/utils/logger";
import fs from "fs";

async function revokeMint() {
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const wallet = loadWallet();
  const tokens = JSON.parse(fs.readFileSync("config/devnet_tokens.json", "utf-8"));

  await setAuthority(connection, wallet, new PublicKey(tokens.tokenA.mint), wallet, AuthorityType.MintTokens, null);
  logger.info("fUSDC mint authority revoked");

  await setAuthority(connection, wallet, new PublicKey(tokens.tokenB.mint), wallet, AuthorityType.MintTokens, null);
  logger.info("fSOL mint authority revoked");

  await setAuthority(connection, wallet, new PublicKey(tokens.tokenC.mint), wallet, AuthorityType.MintTokens, null);
  logger.info("fRAY mint authority revoked");

  logger.info("=== All clean token mint authorities revoked ===");
}

revokeMint().catch(console.error);