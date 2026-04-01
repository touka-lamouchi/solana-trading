import { Keypair } from "@solana/web3.js";
import fs from "fs";
import path from "path";

export function loadWallet(walletPath: string = "config/dev-wallet.json"): Keypair {
  const fullPath = path.resolve(walletPath);
  const secretKey = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(secretKey));
}