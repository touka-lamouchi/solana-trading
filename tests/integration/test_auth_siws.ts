/**
 * test_auth_siws.ts — SIWS + JWT auth flow verification (OWASP A07 / A01).
 *
 * Proves the full sign-in path WITHOUT a browser or real Phantom wallet:
 *   1. issueNonce stores a nonce and returns the message to sign.
 *   2. A generated Keypair signs that exact message (what Phantom would do).
 *   3. verifyAndIssueToken validates the ed25519 signature → mints a JWT.
 *   4. verifyToken round-trips the JWT payload.
 *   5. requireOwner allows the owner, blocks a different userId (IDOR), and
 *      always allows role=admin.
 *   6. Negative cases: bad signature, replayed nonce, tampered message.
 *
 * Uses an in-memory fake Redis (no server). No network, deterministic.
 *
 * Run: npx ts-node tests/integration/test_auth_siws.ts
 */

import nacl from "tweetnacl";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { issueNonce, verifyAndIssueToken, verifyToken } from "../../src/api/auth/siws";
import { makeRequireOwner } from "../../src/api/middleware/auth";

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${message}`);
    failed++;
  }
}

// ── In-memory fake Redis (only the methods siws.ts uses) ───────────────────────
class FakeRedis {
  private store = new Map<string, { v: string; exp: number }>();
  async set(k: string, v: string, _ex: "EX", ttl: number): Promise<void> {
    this.store.set(k, { v, exp: Date.now() + ttl * 1000 });
  }
  async get(k: string): Promise<string | null> {
    const e = this.store.get(k);
    if (!e) return null;
    if (Date.now() > e.exp) { this.store.delete(k); return null; }
    return e.v;
  }
  async del(k: string): Promise<void> { this.store.delete(k); }
}
// getClient must return the SAME instance across calls so the nonce persists.
const sharedRedis = new FakeRedis();
const cache = { getClient: () => sharedRedis } as any;

// ── Helper: sign a message string with a keypair (mimics Phantom signMessage) ──
function signMessage(message: string, kp: Keypair): string {
  const sig = nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey);
  return bs58.encode(sig);
}

// Mock Express req/res for middleware tests.
function mockReqRes(authSub: string | null, role: "user" | "admin", userIdParam: string) {
  let statusCode = 200;
  let nextCalled = false;
  const req: any = {
    params: { userId: userIdParam },
    path: `/users/${userIdParam}/start`,
    auth: authSub ? { sub: authSub, role } : undefined,
  };
  const res: any = {
    status(c: number) { statusCode = c; return this; },
    json() { return this; },
  };
  const next = () => { nextCalled = true; };
  return { req, res, next, get statusCode() { return statusCode; }, get nextCalled() { return nextCalled; } };
}

async function main() {
  console.log("\n=== SIWS + JWT Auth Integration Test ===\n");

  const user = Keypair.generate();
  const userPubkey = user.publicKey.toBase58();

  // 1–3. Happy path: nonce → sign → token
  console.log("Happy path (nonce → sign → JWT):");
  const { message } = await issueNonce(cache, userPubkey);
  assert(message.includes(userPubkey), "nonce message embeds the pubkey");
  assert(message.includes("Nonce:"), "nonce message includes a nonce line");

  const sig = signMessage(message, user);
  const token = await verifyAndIssueToken(cache, userPubkey, sig, []);
  assert(token !== null, "valid signature → JWT issued");

  // 4. Token round-trip
  const payload = token ? verifyToken(token) : null;
  assert(payload?.sub === userPubkey, "JWT subject is the signer's pubkey");
  assert(payload?.role === "user", "JWT role defaults to 'user'");

  // 5. Admin role
  console.log("\nAdmin role:");
  const { message: m2 } = await issueNonce(cache, userPubkey);
  const sig2 = signMessage(m2, user);
  const adminToken = await verifyAndIssueToken(cache, userPubkey, sig2, [userPubkey]);
  assert(verifyToken(adminToken!)?.role === "admin", "pubkey in admin list → role 'admin'");

  // 6. requireOwner middleware (auth enabled)
  console.log("\nrequireOwner (IDOR protection, A01):");
  const requireOwner = makeRequireOwner({ enabled: true });

  const own = mockReqRes(userPubkey, "user", userPubkey);
  requireOwner(own.req, own.res, own.next);
  assert(own.nextCalled && own.statusCode === 200, "owner accessing own resource → allowed");

  const other = mockReqRes(userPubkey, "user", Keypair.generate().publicKey.toBase58());
  requireOwner(other.req, other.res, other.next);
  assert(!other.nextCalled && other.statusCode === 403, "user accessing ANOTHER userId → 403 (IDOR blocked)");

  const admin = mockReqRes(userPubkey, "admin", Keypair.generate().publicKey.toBase58());
  requireOwner(admin.req, admin.res, admin.next);
  assert(admin.nextCalled, "admin accessing any userId → allowed");

  const unauth = mockReqRes(null, "user", userPubkey);
  requireOwner(unauth.req, unauth.res, unauth.next);
  assert(!unauth.nextCalled && unauth.statusCode === 401, "no auth context → 401");

  // 7. Negative: wrong signer
  console.log("\nNegative cases:");
  const attacker = Keypair.generate();
  const { message: m3 } = await issueNonce(cache, userPubkey);
  const wrongSig = signMessage(m3, attacker); // attacker signs, claims to be user
  const badToken = await verifyAndIssueToken(cache, userPubkey, wrongSig, []);
  assert(badToken === null, "signature from a different key → rejected");

  // 8. Negative: nonce replay (nonce consumed on first success)
  const { message: m4 } = await issueNonce(cache, userPubkey);
  const sig4 = signMessage(m4, user);
  const first = await verifyAndIssueToken(cache, userPubkey, sig4, []);
  const replay = await verifyAndIssueToken(cache, userPubkey, sig4, []);
  assert(first !== null && replay === null, "nonce is single-use (replay rejected)");

  // 9. Negative: no nonce issued
  const fresh = Keypair.generate();
  const noNonce = await verifyAndIssueToken(
    cache, fresh.publicKey.toBase58(), signMessage("anything", fresh), []
  );
  assert(noNonce === null, "verify with no issued nonce → rejected");

  // 10. Negative: tampered/garbage token
  assert(verifyToken("not.a.jwt") === null, "garbage token → null");

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
