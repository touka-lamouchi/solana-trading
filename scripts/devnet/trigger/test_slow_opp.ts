/**
 * test_slow_opp — POST /users/:userId/test-slow-opportunity to push a synthetic
 * slow-path opportunity through the running engine. The engine runs the real
 * S1→S4 safety pipeline + protection guard, then broadcasts the rejection (or
 * any terminal decision) over the WebSocket, so the frontend activity log
 * shows it like any normal event.
 *
 * Usage:
 *   npx ts-node scripts/devnet/trigger/test_slow_opp.ts <mint|alias>
 *   npx ts-node scripts/devnet/trigger/test_slow_opp.ts dirty1_mint_authority
 *   npx ts-node scripts/devnet/trigger/test_slow_opp.ts dirty
 *   npx ts-node scripts/devnet/trigger/test_slow_opp.ts fSOL
 *   npx ts-node scripts/devnet/trigger/test_slow_opp.ts ALL
 */

import fs from "fs";

const API = process.env["API"] ?? "http://localhost:3001";

interface NamedToken { alias: string; mint: string }

function loadTokens(): NamedToken[] {
  const out: NamedToken[] = [];
  const clean = JSON.parse(fs.readFileSync("config/devnet_tokens.json", "utf-8"));
  for (const k of Object.keys(clean)) out.push({ alias: clean[k].name, mint: clean[k].mint });
  if (fs.existsSync("config/devnet_dirty_tokens.json")) {
    const dirty = JSON.parse(fs.readFileSync("config/devnet_dirty_tokens.json", "utf-8"));
    for (const k of Object.keys(dirty)) {
      if (dirty[k]?.mint) out.push({ alias: k, mint: dirty[k].mint });
    }
    // Convenience alias "dirty" → first dirty1*
    const d1 = out.find(t => t.alias.startsWith("dirty1"));
    if (d1) out.push({ alias: "dirty", mint: d1.mint });
  }
  return out;
}

function resolve(input: string, known: NamedToken[]): NamedToken | null {
  const lc = input.toLowerCase();
  for (const t of known) if (t.alias.toLowerCase() === lc) return t;
  for (const t of known) if (t.mint === input) return t;
  // Treat as raw mint
  return { alias: input.slice(0, 8), mint: input };
}

async function getActiveUserId(): Promise<string> {
  const r = await fetch(`${API}/users`);
  if (!r.ok) throw new Error(`/users → ${r.status}`);
  const j: any = await r.json();
  const ids: string[] = Array.isArray(j?.activeUsers) ? j.activeUsers : [];
  if (ids.length === 0) throw new Error("no active users — click Start in the frontend first");
  if (ids.length > 1) {
    console.error(`multiple active users: ${ids.join(", ")} — using first`);
  }
  return ids[0]!;
}

async function pushOne(userId: string, t: NamedToken): Promise<void> {
  console.log(`\n→ Pushing slow opp for ${t.alias} (${t.mint.slice(0, 12)}…)`);
  const res = await fetch(`${API}/users/${userId}/test-slow-opportunity`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mint: t.mint }),
  });
  if (!res.ok) {
    console.error(`  HTTP ${res.status}: ${await res.text()}`);
    return;
  }
  const out: any = await res.json();
  console.log(`  result: stage=${out.stage} reasonCode=${out.reasonCode ?? "-"} reason="${out.reason ?? ""}"`);
  console.log(`  → check the frontend activity log for the matching event`);
}

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: test_slow_opp.ts <mint|alias|ALL>");
    process.exit(1);
  }

  const userId = await getActiveUserId();
  console.log(`user: ${userId}`);

  const known = loadTokens();
  const targets: NamedToken[] = target.toLowerCase() === "all"
    ? known
    : [resolve(target, known)!];

  for (const t of targets) {
    try { await pushOne(userId, t); }
    catch (e: any) { console.error(`  error: ${e.message}`); }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
