/**
 * Multi-scenario demo runner.
 *
 * Drives the running API server through a sequence of trading scenarios so a
 * viewer can watch each one play out on the frontend (LiveCockpit, Analytics).
 *
 * Prereqs (all running):
 *   - Redis           (redis-server --daemonize yes)
 *   - AI server       (cd ai && python server.py)
 *   - API server      (npx ts-node src/api/server.ts)
 *   - Frontend        (npm run dev in trading-platform)
 *   - User started in frontend (Phantom connect → click Start)
 *   - Vault deposited (≥ ~50 fUSDC for slow-path scenarios)
 *
 * Run:
 *   npx ts-node scripts/devnet/demo/run_demo.ts <userId>
 *   npx ts-node scripts/devnet/demo/run_demo.ts <userId> --only=arb_win,liq
 *   npx ts-node scripts/devnet/demo/run_demo.ts <userId> --pause=20 --settle=25
 */

import WebSocket from "ws";
import { spawn } from "child_process";
import path from "path";

const API = "http://localhost:3001";
const WS = "ws://localhost:3001/ws";

// ── CLI args ─────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const positional = argv.filter(a => !a.startsWith("--"));
let userId = positional[0] || "";
const only = (argv.find(a => a.startsWith("--only=")) || "").split("=")[1]?.split(",") || null;
const pauseSec = parseInt((argv.find(a => a.startsWith("--pause=")) || "").split("=")[1] || "15", 10);
const settleSec = parseInt((argv.find(a => a.startsWith("--settle=")) || "").split("=")[1] || "20", 10);

// ── Helpers ──────────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function banner(title: string, sub: string) {
  const line = "═".repeat(72);
  console.log(`\n${line}\n  ${title}\n  ${sub}\n${line}`);
}

function log(msg: string) {
  console.log(`  ${msg}`);
}

async function http(method: "GET" | "POST", url: string, body?: any): Promise<any> {
  const init: RequestInit = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${API}${url}`, init);
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${await res.text()}`);
  return res.json();
}

async function getConfig() { return http("GET", `/users/${userId}/config`); }
async function setConfig(patch: any) { return http("POST", `/users/${userId}/config`, patch); }
async function getStatus() { return http("GET", `/users/${userId}/status`); }
// /users/:userId/trades returns an ARRAY (not { trades: [...] }).
async function getTrades(): Promise<any[]> {
  const r = await http("GET", `/users/${userId}/trades`);
  return Array.isArray(r) ? r : (r?.trades ?? []);
}

function runTrigger(script: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise(resolve => {
    const child = spawn("npx", ["ts-node", `scripts/devnet/trigger/${script}`, ...args], {
      cwd: path.resolve(__dirname, "../../.."),
      shell: true,
    });
    let stdout = "";
    child.stdout.on("data", b => (stdout += b.toString()));
    child.stderr.on("data", b => (stdout += b.toString()));
    child.on("close", code => resolve({ code: code ?? -1, stdout }));
  });
}

// ── WS event collector ───────────────────────────────────────────────────────
type WsEvent = { type: string; userId?: string; [k: string]: any };
const wsEvents: WsEvent[] = [];
let ws: WebSocket | null = null;

function startWs() {
  ws = new WebSocket(WS);
  ws.on("open", () => log("[ws] connected"));
  ws.on("message", raw => {
    try {
      const e = JSON.parse(raw.toString());
      if (e.userId && e.userId !== userId) return;
      wsEvents.push(e);
    } catch { /* ignore */ }
  });
  ws.on("error", () => { /* ignore — server may briefly not respond */ });
}

function eventsSince(t0: number, type?: string): WsEvent[] {
  return wsEvents.filter(e => (e._tRecv ?? 0) >= t0 && (!type || e.type === type));
}

function recordRecv() {
  // tag events with receive time after-the-fact for windowing
  for (const e of wsEvents) if ((e as any)._tRecv === undefined) (e as any)._tRecv = Date.now();
}

// ── Scenario framework ───────────────────────────────────────────────────────
interface Scenario {
  name: string;
  watchFor: string;      // human-readable hint shown in banner
  run: () => Promise<{ ok: boolean; note: string }>;
}

const results: { name: string; ok: boolean; note: string }[] = [];

async function withConfig<T>(patch: any, fn: () => Promise<T>): Promise<T> {
  const before = await getConfig();
  const restoreKeys = Object.keys(patch);
  const restorePatch: any = {};
  for (const k of restoreKeys) restorePatch[k] = (before as any)[k];
  await setConfig(patch);
  try {
    return await fn();
  } finally {
    await setConfig(restorePatch);
  }
}

// ── Scenarios ────────────────────────────────────────────────────────────────
const scenarios: Scenario[] = [
  {
    name: "reset",
    watchFor: "config restored to defaults; trade log baseline noted",
    run: async () => {
      await setConfig({
        dailyLimitUsd: 500,
        maxTradeUsd: 1000,
        flashLoans: true,
        liquidations: true,
        yieldGaps: false,
        chartPatterns: false,
        socialBuzz: false,
        copyWhales: false,
        mode: "active",
        tradingHoursStart: "00:00",
        tradingHoursEnd: "23:59",
      });
      const trades = await getTrades();
      return { ok: true, note: `baseline trades today: ${trades.length}` };
    },
  },

  {
    name: "arb_win",
    watchFor: "frontend → triangular arb trade rows with green profit",
    run: async () => {
      const t0 = Date.now();
      recordRecv();
      const r = await runTrigger("create_arb.ts", ["pool1", "0.3", "--reverse"]);
      log(`create_arb exit ${r.code}`);
      await sleep(settleSec * 1000);
      recordRecv();
      const trades = await getTrades();
      const recent = trades.filter((t: any) => (t.timestamp ?? 0) >= t0);
      const wins = recent.filter((t: any) => (t.profit ?? 0) > 0);
      return {
        ok: wins.length > 0,
        note: `${wins.length} winning arb(s) since trigger, total +$${wins.reduce((a: number, t: any) => a + (t.profit ?? 0), 0).toFixed(2)}`,
      };
    },
  },

  {
    name: "arb_win_fusdc",
    watchFor: "same as arb_win but pushes pool with fUSDC (needs fUSDC in bot wallet)",
    run: async () => {
      const t0 = Date.now();
      const r = await runTrigger("create_arb.ts", ["pool1", "500"]);
      log(`create_arb exit ${r.code} (500 fUSDC)`);
      await sleep(settleSec * 1000);
      const trades = await getTrades();
      const recent = trades.filter((t: any) => (t.timestamp ?? 0) >= t0);
      const wins = recent.filter((t: any) => (t.profit ?? 0) > 0);
      return {
        ok: wins.length > 0,
        note: r.code !== 0
          ? "create_arb exited non-zero — likely bot wallet has insufficient fUSDC (refill to enable)"
          : `${wins.length} winning arb(s), total +$${wins.reduce((a: number, t: any) => a + (t.profit ?? 0), 0).toFixed(2)}`,
      };
    },
  },

  {
    name: "arb_cascade_observation",
    watchFor: "frontend shows multiple shrinking-profit arb rows in a row",
    run: async () => {
      const t0 = Date.now();
      const r = await runTrigger("create_arb.ts", ["pool1", "0.6", "--reverse"]);
      log(`create_arb exit ${r.code} (0.6 fSOL swap to push pool further out of equilibrium)`);
      await sleep(settleSec * 1000);
      const trades = await getTrades();
      const recent = trades.filter((t: any) => (t.timestamp ?? 0) >= t0);
      return {
        ok: recent.length >= 2,
        note: `cascade had ${recent.length} sequential arbs (each rebalances the pool, next one is smaller)`,
      };
    },
  },

  {
    name: "arb_cascade_fusdc",
    watchFor: "cascade variant pushed with fUSDC (skip if bot wallet lacks fUSDC)",
    run: async () => {
      const t0 = Date.now();
      const r = await runTrigger("create_arb.ts", ["pool1", "1500"]);
      log(`create_arb exit ${r.code} (1500 fUSDC)`);
      await sleep(settleSec * 1000);
      const trades = await getTrades();
      const recent = trades.filter((t: any) => (t.timestamp ?? 0) >= t0);
      return {
        ok: recent.length >= 2,
        note: r.code !== 0
          ? "create_arb exited non-zero — likely bot wallet has insufficient fUSDC"
          : `cascade had ${recent.length} sequential arbs`,
      };
    },
  },

  {
    name: "fee_guard_skip",
    watchFor: "tiny gap — frontend shows 0 trades; bot skips because expected profit < gas × multiplier",
    run: async () => {
      const t0 = Date.now();
      const r = await runTrigger("create_arb.ts", ["pool1", "0.01", "--reverse"]);
      log(`create_arb 0.01 fSOL (tiny gap)`);
      await sleep(settleSec * 1000);
      const trades = await getTrades();
      const recent = trades.filter((t: any) => (t.timestamp ?? 0) >= t0);
      // Honest assertion: 0 = fee guard skipped (good); >0 = gap was too big (re-tune).
      return {
        ok: recent.length === 0,
        note: recent.length === 0
          ? "fee guard skipped tiny opportunity (no trades) — guard works"
          : `${recent.length} trades fired despite tiny gap — fee guard didn't kick in (gas low or gap not tiny enough)`,
      };
    },
  },

  {
    name: "fee_guard_skip_fusdc",
    watchFor: "tiny-gap variant pushed with fUSDC",
    run: async () => {
      const t0 = Date.now();
      const r = await runTrigger("create_arb.ts", ["pool1", "50"]);
      log(`create_arb 50 fUSDC (tiny gap)`);
      await sleep(settleSec * 1000);
      const trades = await getTrades();
      const recent = trades.filter((t: any) => (t.timestamp ?? 0) >= t0);
      return {
        ok: recent.length === 0,
        note: r.code !== 0
          ? "create_arb exited non-zero — likely bot wallet has insufficient fUSDC"
          : recent.length === 0
            ? "fee guard skipped tiny fUSDC opportunity"
            : `${recent.length} trades fired despite tiny gap`,
      };
    },
  },

  {
    name: "drawdown_stop",
    watchFor: "frontend protection panel flips to PAUSED (drawdown limit hit)",
    run: () => withConfig({ dailyLimitUsd: 0.01 }, async () => {
      const before = await getStatus();
      log(`drawdownUsed before: $${before.drawdownUsed?.toFixed(4) ?? "?"} / $${before.drawdownLimit ?? "?"}`);
      log("set dailyLimitUsd=0.01 — any profitable trade now exceeds drawdown");
      const t0 = Date.now();
      await runTrigger("create_arb.ts", ["pool1", "1500"]);
      await sleep(settleSec * 1000);
      const after = await getStatus();
      const trades = await getTrades();
      const recent = trades.filter((t: any) => (t.timestamp ?? 0) >= t0);
      const exceeded = (after.drawdownUsed ?? 0) > (after.drawdownLimit ?? Infinity);
      log(`drawdownUsed after: $${after.drawdownUsed?.toFixed(4) ?? "?"} / $${after.drawdownLimit ?? "?"}, recent trades: ${recent.length}`);
      // Pass if drawdown was exceeded and no further trades happen, OR if no trade fired at all
      // (because guard rejected before execution).
      return {
        ok: exceeded || recent.length === 0,
        note: exceeded
          ? `drawdown exceeded ($${(after.drawdownUsed ?? 0).toFixed(2)} > $${(after.drawdownLimit ?? 0).toFixed(2)})`
          : recent.length === 0
            ? "no trades during the trigger — drawdown guard rejected pre-execution"
            : `${recent.length} trade(s) executed but drawdown not flagged — check protection wiring`,
      };
    }),
  },

  {
    name: "trading_hours_block",
    watchFor: "frontend shows no executions during the closed window",
    run: () => withConfig({
      tradingHoursStart: "00:00",
      tradingHoursEnd: "00:01",
    }, async () => {
      log("set trading window to a 1-minute past slot — current time is outside");
      const t0 = Date.now();
      await runTrigger("create_arb.ts", ["pool1", "1500"]);
      await sleep(settleSec * 1000);
      const trades = await getTrades();
      const recent = trades.filter((t: any) => (t.timestamp ?? 0) >= t0);
      return {
        ok: recent.length === 0,
        note: recent.length === 0
          ? "0 trades during closed hours — guard works"
          : `${recent.length} trades leaked through closed-hours guard`,
      };
    }),
  },

  {
    name: "liquidations_disabled",
    watchFor: "register a liquidatable position — bot ignores it (liquidations toggle off)",
    run: () => withConfig({ liquidations: false }, async () => {
      const t0 = Date.now();
      const status = await getStatus();
      // Try to register a position with high enough debt
      const cur = await getCurrentFsolPrice();
      const debt = Math.ceil((cur ?? 4500) / 1.10); // health < 1.20
      log(`registering position: 1 fSOL collateral / ${debt} fUSDC debt (current fSOL≈${cur})`);
      const r = await runTrigger("register_position.ts", [
        "--collateralToken=fSOL", "--collateralAmount=1",
        "--debtToken=fUSDC", `--debtAmount=${debt}`,
        "--threshold=1.20",
      ]);
      log(`register_position exit ${r.code}`);
      await sleep(settleSec * 1000);
      // Look for a liq trade since t0 — there should be none
      const trades = await getTrades();
      const liqs = trades.filter((t: any) =>
        (t.timestamp ?? 0) >= t0 && (t.oppType === "liquidation" || /liquidation/i.test(t.pair ?? "")),
      );
      return {
        ok: liqs.length === 0,
        note: liqs.length === 0 ? "no liq executed — toggle works" : `${liqs.length} liq leaked through`,
      };
    }),
  },

  {
    name: "liquidation_win",
    watchFor: "frontend → liquidation trade row with positive profit",
    run: async () => {
      const t0 = Date.now();
      const cur = await getCurrentFsolPrice();
      const debt = Math.ceil((cur ?? 4500) / 1.10);
      log(`registering liquidatable position: 1 fSOL / ${debt} fUSDC, threshold 1.20`);
      const r = await runTrigger("register_position.ts", [
        "--collateralToken=fSOL", "--collateralAmount=1",
        "--debtToken=fUSDC", `--debtAmount=${debt}`,
        "--threshold=1.20",
      ]);
      if (r.code !== 0) return { ok: false, note: "register_position failed" };
      await sleep(settleSec * 1000);
      const trades = await getTrades();
      const liqs = trades.filter((t: any) =>
        (t.timestamp ?? 0) >= t0 && (t.oppType === "liquidation" || /liquidation/i.test(t.pair ?? "")),
      );
      return {
        ok: liqs.length > 0,
        note: liqs.length > 0
          ? `liquidation executed (${liqs[0].signature?.slice(0, 12) ?? "?"}…)`
          : "no liq executed — check API server log for [Graph] Liq result reason",
      };
    },
  },

  {
    name: "safety_dirty_pool",
    watchFor: "S1–S4 pipeline reports rejection on a slow-path opportunity",
    run: async () => {
      // Honest: this scenario can't trigger a slow-path opportunity on the dirty
      // token from outside (no trigger script targets pool4_dirty for a directional
      // opp). We watch for any safety_rejected WS event during the settle window.
      return withConfig({ chartPatterns: true, socialBuzz: true, mode: "active" }, async () => {
        const t0 = Date.now();
        recordRecv();
        await sleep(settleSec * 1000);
        recordRecv();
        const evs = eventsSince(t0, "safety_rejected");
        return {
          ok: evs.length > 0,
          note: evs.length > 0
            ? `${evs.length} safety_rejected event(s) — S1–S4 fired`
            : "no safety_rejected events — slow-path didn't generate an opp targeting the dirty token. Need a dedicated trigger (todo).",
        };
      });
    },
  },

  {
    name: "vault_status",
    watchFor: "vault balance + activity reported",
    run: async () => {
      const status = await getStatus();
      const bal = status.vaultBalance ?? 0;
      const profit = status.vaultProfit ?? 0;
      const exists = status.vaultExists ?? false;
      return {
        ok: exists && bal > 0,
        note: `vault: exists=${exists}, balance=${bal} fUSDC, lifetime profit=${profit.toFixed(2)} fUSDC, pda=${status.vaultPda?.slice(0, 12) ?? "?"}`,
      };
    },
  },

  {
    name: "summary",
    watchFor: "report",
    run: async () => {
      const status = await getStatus();
      const trades = await getTrades();
      log(`final: trades_today=${trades.length}, vault=${status.vaultBalance ?? "?"}, dailyPnL=${status.dailyPnl ?? "?"}`);
      return { ok: true, note: "demo complete" };
    },
  },
];

// ── Helpers used by scenarios ────────────────────────────────────────────────
async function getCurrentFsolPrice(): Promise<number | null> {
  try {
    const market = await http("GET", "/market");
    // Prefer pool1 reserves if exposed
    const p1 = market?.pools?.find((p: any) => p.key === "pool1");
    if (p1 && p1.reserveB > 0) return p1.reserveA / p1.reserveB;
  } catch { /* ignore */ }
  return null;
}

// ── Main loop ────────────────────────────────────────────────────────────────
async function resolveUserId(): Promise<string> {
  if (userId) return userId;
  const list = await http("GET", "/users");
  const ids: string[] = Array.isArray(list?.activeUsers) ? list.activeUsers : [];
  if (ids.length === 0) {
    throw new Error("no active users found — pass userId explicitly or click Start in the frontend");
  }
  if (ids.length > 1) {
    throw new Error(`multiple active users (${ids.join(", ")}) — pass userId explicitly`);
  }
  return ids[0]!;
}

async function main() {
  startWs();
  try {
    userId = await resolveUserId();
  } catch (e: any) {
    console.error(e.message);
    process.exit(2);
  }
  banner("DEMO", `user=${userId}  pause=${pauseSec}s  settle=${settleSec}s`);

  // Sanity check: API up + user started + vault sane
  try {
    const status = await getStatus();
    log(`running=${status.running}, mode=${status.mode}, vaultBalance=${status.vaultBalance ?? "?"} fUSDC, vaultPda=${status.vaultPda ?? "?"}`);
    log(`tradesToday=${status.tradesToday ?? 0}, dailyPnL=${status.dailyPnl ?? 0}, drawdown=${status.drawdownUsed ?? 0}/${status.drawdownLimit ?? "?"}`);
    if (!status.running) {
      console.error("user is not running — click Start in the frontend first");
      process.exit(2);
    }
  } catch (e: any) {
    console.error(`API not reachable or user ${userId} not started: ${e.message}`);
    process.exit(2);
  }

  for (const sc of scenarios) {
    if (only && !only.includes(sc.name)) continue;
    banner(`SCENARIO: ${sc.name}`, `WATCH FRONTEND: ${sc.watchFor}`);
    log(`pausing ${pauseSec}s before triggering — bring frontend to focus`);
    await sleep(pauseSec * 1000);
    log("triggering…");
    let res: { ok: boolean; note: string };
    try {
      res = await sc.run();
    } catch (e: any) {
      res = { ok: false, note: `error: ${e.message}` };
    }
    results.push({ name: sc.name, ...res });
    log(`${res.ok ? "✓ PASS" : "✗ FAIL"}  ${res.note}`);
  }

  // ── Final report ───────────────────────────────────────────────────────────
  banner("REPORT", `${results.length} scenarios`);
  for (const r of results) {
    console.log(`  [${r.ok ? "PASS" : "FAIL"}] ${r.name.padEnd(26)} — ${r.note}`);
  }
  const passed = results.filter(r => r.ok).length;
  console.log(`\n  ${passed}/${results.length} passed\n`);

  ws?.close();
  process.exit(0);
}

main().catch(e => {
  console.error("demo crashed:", e);
  ws?.close();
  process.exit(1);
});
