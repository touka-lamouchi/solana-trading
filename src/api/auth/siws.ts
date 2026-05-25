// Sign-In With Solana (SIWS) + JWT.
//
// Flow:
//   1. GET  /auth/nonce?pubkey=<base58>  → server stores a random nonce in Redis
//      (5-min TTL) and returns the human-readable message the wallet must sign.
//   2. POST /auth/verify { pubkey, signature } → server verifies the ed25519
//      signature against the stored nonce, then issues a short-lived JWT.
//   3. Client sends `Authorization: Bearer <jwt>` on every protected request.
//
// This proves the caller controls the private key for `pubkey` WITHOUT the key
// ever leaving the wallet. The JWT `sub` claim is the pubkey, which downstream
// ownership middleware compares against `:userId` (OWASP A01 fix).
//
// Mitigates OWASP A07 (Identification & Authentication Failures) and is the
// precondition for the A01 (Broken Access Control / IDOR) fix.

import nacl from "tweetnacl";
import bs58 from "bs58";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { PublicKey } from "@solana/web3.js";
import { CacheManager } from "../../cache/cache_manager";
import { logger } from "../../utils/logger";

const NONCE_TTL_SECONDS = 300; // 5 minutes
const ACCESS_TOKEN_TTL = "15m";
const NONCE_PREFIX = "auth:nonce:";

export interface JwtPayload {
  sub: string; // the user's Solana pubkey (base58)
  role: "user" | "admin";
}

/** The JWT signing secret. MUST be set via env in any non-dev deployment. */
function getJwtSecret(): string {
  const secret = process.env["JWT_SECRET"];
  if (secret && secret.length >= 32) return secret;
  // Dev fallback: deterministic-per-process random secret. Tokens won't survive
  // a restart, which is acceptable for devnet but unusable for production.
  if (!process.env["JWT_SECRET"]) {
    logger.warn(
      "JWT_SECRET not set (or < 32 chars). Using an ephemeral dev secret — " +
        "tokens will be invalidated on restart. Set JWT_SECRET for production."
    );
  }
  return DEV_EPHEMERAL_SECRET;
}
const DEV_EPHEMERAL_SECRET = crypto.randomBytes(48).toString("hex");

/** Validate that a string is a real base58 ed25519 pubkey. */
export function isValidPubkey(pubkey: string): boolean {
  try {
    // PublicKey ctor throws on bad length / bad base58.
    // eslint-disable-next-line no-new
    new PublicKey(pubkey);
    return true;
  } catch {
    return false;
  }
}

/** Build the message the wallet signs. Includes the nonce so it can't be replayed. */
export function buildSignMessage(pubkey: string, nonce: string): string {
  return (
    `Solana Trading Bot wants you to sign in.\n\n` +
    `Wallet: ${pubkey}\n` +
    `Nonce: ${nonce}\n\n` +
    `Signing this message proves you control this wallet. It does not authorize ` +
    `any transaction and costs no fees.`
  );
}

/** Step 1: generate + persist a nonce, return the message to sign. */
export async function issueNonce(
  cache: CacheManager,
  pubkey: string
): Promise<{ message: string; nonce: string }> {
  const nonce = crypto.randomBytes(24).toString("hex");
  const redis = cache.getClient();
  await redis.set(`${NONCE_PREFIX}${pubkey}`, nonce, "EX", NONCE_TTL_SECONDS);
  return { message: buildSignMessage(pubkey, nonce), nonce };
}

/**
 * Step 2: verify the signature against the stored nonce. On success the nonce is
 * consumed (single-use) and a JWT is returned. Returns null on any failure.
 */
export async function verifyAndIssueToken(
  cache: CacheManager,
  pubkey: string,
  signatureB58: string,
  adminPubkeys: string[]
): Promise<string | null> {
  if (!isValidPubkey(pubkey)) return null;

  const redis = cache.getClient();
  const key = `${NONCE_PREFIX}${pubkey}`;
  const nonce = await redis.get(key);
  if (!nonce) {
    logger.warn({ pubkey }, "SIWS verify: no/expired nonce");
    return null;
  }

  const message = buildSignMessage(pubkey, nonce);
  let ok = false;
  try {
    ok = nacl.sign.detached.verify(
      new TextEncoder().encode(message),
      bs58.decode(signatureB58),
      bs58.decode(pubkey)
    );
  } catch (e: any) {
    logger.warn({ pubkey, error: e.message }, "SIWS verify: signature decode failed");
    return null;
  }

  if (!ok) {
    logger.warn({ pubkey }, "SIWS verify: bad signature");
    return null;
  }

  // Consume the nonce so the same signature can't be replayed.
  await redis.del(key);

  const role: JwtPayload["role"] = adminPubkeys.includes(pubkey) ? "admin" : "user";
  const token = jwt.sign({ sub: pubkey, role } as JwtPayload, getJwtSecret(), {
    expiresIn: ACCESS_TOKEN_TTL,
  });
  logger.info({ pubkey, role }, "SIWS verify: token issued");
  return token;
}

/** Verify a bearer token. Returns the payload or null. */
export function verifyToken(token: string): JwtPayload | null {
  try {
    return jwt.verify(token, getJwtSecret()) as JwtPayload;
  } catch {
    return null;
  }
}
