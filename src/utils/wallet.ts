import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import fs from "fs";
import path from "path";

// Key loading precedence (OWASP A02 — Cryptographic Failures / key management):
//   1. BOT_WALLET_SECRET env var — a base58 secret key OR a JSON byte array.
//      Preferred for production: keep the key out of the repo working tree and
//      inject it from a secrets manager / KMS at deploy time.
//   2. config/dev-wallet.json on disk — devnet convenience fallback (gitignored).
export function loadWallet(walletPath: string = "config/dev-wallet.json"): Keypair {
  const fromEnv = process.env["BOT_WALLET_SECRET"];
  if (fromEnv && fromEnv.trim().length > 0) {
    const raw = fromEnv.trim();
    try {
      if (raw.startsWith("[")) {
        return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
      }
      return Keypair.fromSecretKey(bs58.decode(raw));
    } catch (e: any) {
      throw new Error(`BOT_WALLET_SECRET is set but invalid: ${e.message}`);
    }
  }

  const fullPath = path.resolve(walletPath);
  const secretKey = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(secretKey));
}