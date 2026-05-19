/**
 * test_safety — runs the real SafetyPipeline (S1 → S4) directly against a
 * mint and reports which stage rejects, with details. No engine, no graph,
 * no config toggles — this is the same code path the slow-path executor
 * uses, just invoked standalone.
 *
 * Usage:
 *   npx ts-node scripts/devnet/trigger/test_safety.ts <mint>
 *   npx ts-node scripts/devnet/trigger/test_safety.ts dirty
 *   npx ts-node scripts/devnet/trigger/test_safety.ts fSOL
 *   npx ts-node scripts/devnet/trigger/test_safety.ts ALL
 *
 * Aliases:
 *   dirty  → mint of the dirty1 token (devnet_dirty_tokens.json)
 *   fSOL   → tokenB.mint from devnet_tokens.json
 *   fUSDC  → tokenA.mint
 *   fRAY   → tokenC.mint
 *   ALL    → run all known tokens, print summary
 */

import { Connection } from "@solana/web3.js";
import fs from "fs";
import { SafetyPipeline } from "../../../src/layer1_opportunity/safety_filters/safety_pipeline";
import { CacheManager } from "../../../src/cache/cache_manager";
import { getConfig } from "../../../src/utils/config";
import { logger } from "../../../src/utils/logger";

interface KnownToken {
  alias: string;
  name: string;
  mint: string;
  poolAddress?: string;   // optional: pool to use for S2 honeypot simulation
  expectFail?: string;    // optional: which Sx is expected to reject
}

function loadKnownTokens(): KnownToken[] {
  const out: KnownToken[] = [];

  // Clean tokens
  const clean = JSON.parse(fs.readFileSync("config/devnet_tokens.json", "utf-8"));
  const pools = JSON.parse(fs.readFileSync("config/devnet_pools.json", "utf-8"));
  const findPoolFor = (mint: string): string | undefined => {
    for (const k of Object.keys(pools)) {
      const p = pools[k];
      // try explicit mint fields, then symbol resolution
      if (p.tokenAMint === mint || p.tokenBMint === mint) return p.address;
    }
    return undefined;
  };

  for (const key of Object.keys(clean)) {
    const t = clean[key];
    out.push({
      alias: t.name, name: t.name, mint: t.mint,
      ...(findPoolFor(t.mint) ? { poolAddress: findPoolFor(t.mint)! } : {}),
    });
  }

  // Dirty tokens (if file exists). Each entry's key is the alias, e.g.
  // "dirty1_mint_authority" / "dirty2_dev_heavy" / "clean".
  if (fs.existsSync("config/devnet_dirty_tokens.json")) {
    const dirty = JSON.parse(fs.readFileSync("config/devnet_dirty_tokens.json", "utf-8"));
    for (const key of Object.keys(dirty)) {
      const t = dirty[key];
      if (!t?.mint) continue;
      const expected =
        key.startsWith("dirty1") ? "S1" :
        key.startsWith("dirty2") ? "S1" :
        undefined;  // "clean" should pass everything
      out.push({
        alias: key,
        name: key,
        mint: t.mint,
        ...(findPoolFor(t.mint) ? { poolAddress: findPoolFor(t.mint)! } : {}),
        ...(expected ? { expectFail: expected } : {}),
      });
    }
  }

  // Convenience alias "dirty" → first dirty1 entry.
  const firstDirty = out.find(t => t.alias.startsWith("dirty1"));
  if (firstDirty && !out.find(t => t.alias === "dirty")) {
    out.push({ ...firstDirty, alias: "dirty" });
  }

  return out;
}

function resolveAlias(input: string, known: KnownToken[]): KnownToken | null {
  // Exact mint match
  for (const t of known) if (t.mint === input) return t;
  // Alias / name match (case-insensitive)
  const lc = input.toLowerCase();
  for (const t of known) {
    if (t.alias.toLowerCase() === lc || t.name.toLowerCase() === lc) return t;
  }
  // Treat input as a raw mint string the user passed
  return { alias: input.slice(0, 8), name: input.slice(0, 8), mint: input };
}

function bar(): string { return "═".repeat(72); }
function section(title: string) { console.log(`\n${bar()}\n  ${title}\n${bar()}`); }

async function runOne(pipeline: SafetyPipeline, t: KnownToken): Promise<{ pass: boolean; failedAt?: string; details: any }> {
  console.log(`\n→ Testing ${t.name} (${t.mint.slice(0, 12)}…)`);
  if (t.expectFail) console.log(`  expectation: REJECTED at ${t.expectFail}`);
  if (t.poolAddress) console.log(`  pool: ${t.poolAddress.slice(0, 12)}…`);

  const t0 = Date.now();
  let result: any;
  try {
    result = await pipeline.check(t.mint, t.poolAddress);
  } catch (e: any) {
    return { pass: false, failedAt: "ERROR", details: { error: e.message } };
  }
  const dt = Date.now() - t0;

  console.log(`  duration: ${dt}ms`);
  console.log(`  result:   ${result.passed ? "PASSED ALL" : `REJECTED at ${result.failedAt}`}`);

  if (result.s1) {
    console.log(`  S1 onchain heuristics: passed=${result.s1.passed}${result.s1.failReason ? ` — ${result.s1.failReason}` : ""}`);
    if (result.s1.checks) {
      for (const [k, v] of Object.entries(result.s1.checks)) {
        console.log(`     • ${k}: ${JSON.stringify(v)}`);
      }
    }
  }
  if (result.s2) {
    console.log(`  S2 honeypot detect:    passed=${result.s2.passed} isHoneypot=${result.s2.isHoneypot} sellSimulated=${result.s2.sellSimulated}${result.s2.failReason ? ` — ${result.s2.failReason}` : ""}`);
  }
  if (result.s3) {
    const score = typeof result.s3.anomalyScore === "number" ? result.s3.anomalyScore.toFixed(3) : "n/a";
    const thr = typeof result.s3.threshold === "number" ? result.s3.threshold.toFixed(3) : "n/a";
    console.log(`  S3 isolation forest:   passed=${result.s3.passed} score=${score} threshold=${thr}${result.s3.failReason ? ` — ${result.s3.failReason}` : ""}`);
  }
  if (result.s4) {
    console.log(`  S4 anomaly detection:  passed=${result.s4.passed}${result.s4.failReason ? ` — ${result.s4.failReason}` : ""}`);
    if (result.s4.checks) {
      for (const [k, v] of Object.entries(result.s4.checks)) {
        console.log(`     • ${k}: ${JSON.stringify(v)}`);
      }
    }
  }

  if (t.expectFail) {
    if (result.failedAt === t.expectFail) console.log(`  ✓ matched expectation (rejected at ${t.expectFail})`);
    else if (result.passed) console.log(`  ✗ expected REJECT at ${t.expectFail} but token PASSED`);
    else console.log(`  ✗ expected REJECT at ${t.expectFail} but rejected at ${result.failedAt}`);
  }
  return { pass: result.passed, failedAt: result.failedAt, details: result };
}

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: test_safety.ts <mint|alias|ALL>");
    process.exit(1);
  }

  section("SAFETY PIPELINE TEST  (S1 → S4)");
  const cfg = getConfig();
  console.log(`  RPC: ${cfg.network.rpc_url}`);

  const connection = new Connection(cfg.network.rpc_url, "confirmed");
  const cache = new CacheManager();
  // CacheManager auto-connects in its constructor — sanity check ping.
  await cache.ping();
  const pipeline = new SafetyPipeline(connection, cache);

  const known = loadKnownTokens();

  const targets: KnownToken[] = target.toLowerCase() === "all"
    ? known
    : [resolveAlias(target, known)!];

  if (!targets[0]) {
    console.error(`No token matched: ${target}`);
    process.exit(2);
  }

  const summary: Array<{ name: string; pass: boolean; failedAt?: string; expected?: string; matched?: boolean }> = [];
  for (const t of targets) {
    const r = await runOne(pipeline, t);
    summary.push({
      name: t.name,
      pass: r.pass,
      ...(r.failedAt !== undefined ? { failedAt: r.failedAt } : {}),
      ...(t.expectFail !== undefined ? { expected: t.expectFail } : {}),
      ...(t.expectFail !== undefined ? { matched: r.failedAt === t.expectFail } : {}),
    });
  }

  section("REPORT");
  for (const s of summary) {
    const status = s.pass ? "PASSED" : `REJECTED@${s.failedAt}`;
    const expectation = s.expected
      ? (s.matched ? "  ✓ matches expected" : `  ✗ expected REJECT@${s.expected}`)
      : "";
    console.log(`  ${s.name.padEnd(14)} → ${status}${expectation}`);
  }
  const passed = summary.filter(s => s.pass).length;
  const rejected = summary.filter(s => !s.pass).length;
  console.log(`\n  ${passed} passed, ${rejected} rejected, ${summary.length} total`);

  await cache.disconnect();
  process.exit(0);
}

main().catch(e => {
  logger.error({ err: e.message ?? e }, "test_safety failed");
  process.exit(1);
});
