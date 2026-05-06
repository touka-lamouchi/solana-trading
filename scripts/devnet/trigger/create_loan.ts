/**
 * Register a loan position in the bot's lending registry (Redis).
 *
 * Usage:
 *   npx ts-node scripts/devnet/create_loan.ts \
 *     --collateralToken=fSOL --collateralAmount=10 \
 *     --debtToken=fUSDC --debtAmount=1500 \
 *     --threshold=1.20
 *
 * What it does:
 *   - Creates a position record in Redis under loan:<id>
 *   - Adds <id> to the set "loans:registry"
 *   - The bot's LiquidationHunter loads these every tick and computes health
 *     using REAL pool reserve prices. When the health ratio (collateralValue
 *     / debtValue) drops below `threshold`, the bot fires a liquidation
 *     opportunity and executes a real swap.
 *
 * To trigger a liquidation:
 *   1. Create a position close to its threshold:
 *        --collateralAmount=10 --debtAmount=1500 with current fSOL price ~$170 →
 *        collateralValue=$1700, debtValue=$1500, health=1.13 (above 1.20? no — under)
 *   2. Or push the pool price the wrong way with create_arb.ts so an existing
 *      position dips under threshold.
 *
 * List positions:
 *   npx ts-node scripts/devnet/create_loan.ts --list
 *
 * Delete one:
 *   npx ts-node scripts/devnet/create_loan.ts --delete=<id>
 *
 * Clear all:
 *   npx ts-node scripts/devnet/create_loan.ts --clear
 */

import { CacheManager } from "../../../src/cache/cache_manager";
import { logger } from "../../../src/utils/logger";
import crypto from "crypto";

interface Args {
  collateralToken?: string;
  collateralAmount?: number;
  debtToken?: string;
  debtAmount?: number;
  threshold?: number;
  borrower?: string;
  list?: boolean;
  clear?: boolean;
  delete?: string;
}

function parseArgs(): Args {
  const out: Args = {};
  for (const arg of process.argv.slice(2)) {
    const [k, v] = arg.replace(/^--/, "").split("=");
    if (k === "list") out.list = true;
    else if (k === "clear") out.clear = true;
    else if (k === "delete") out.delete = v ?? "";
    else if (k === "collateralToken") out.collateralToken = v ?? "";
    else if (k === "debtToken") out.debtToken = v ?? "";
    else if (k === "borrower") out.borrower = v ?? "";
    else if (k === "collateralAmount") out.collateralAmount = parseFloat(v!);
    else if (k === "debtAmount") out.debtAmount = parseFloat(v!);
    else if (k === "threshold") out.threshold = parseFloat(v!);
  }
  return out;
}

async function main() {
  const args = parseArgs();
  const cache = new CacheManager();
  const client = cache.getClient();

  if (args.list) {
    const ids = await client.smembers("loans:registry");
    if (ids.length === 0) {
      logger.info("No loan positions registered.");
    } else {
      for (const id of ids) {
        const raw = await client.get(`loan:${id}`);
        if (raw) logger.info({ id, ...JSON.parse(raw) }, "loan");
      }
    }
    await cache.disconnect();
    return;
  }

  if (args.clear) {
    const ids = await client.smembers("loans:registry");
    for (const id of ids) await client.del(`loan:${id}`);
    await client.del("loans:registry");
    logger.info({ removed: ids.length }, "Cleared registry");
    await cache.disconnect();
    return;
  }

  if (args.delete) {
    await client.srem("loans:registry", args.delete);
    await client.del(`loan:${args.delete}`);
    logger.info({ id: args.delete }, "Deleted");
    await cache.disconnect();
    return;
  }

  // Validate required args
  const required = ["collateralToken", "collateralAmount", "debtToken", "debtAmount", "threshold"];
  for (const r of required) {
    if (!(r in args) || (args as any)[r] === undefined) {
      console.error(`Missing --${r}`);
      console.error("Required: --collateralToken --collateralAmount --debtToken --debtAmount --threshold");
      process.exit(1);
    }
  }

  const id = crypto.randomBytes(6).toString("hex");
  const borrower = args.borrower
    ?? `Loan${id.toUpperCase()}${"x".repeat(32 - id.length - 4)}`;

  // Initial prices set to placeholders — the bot will overwrite from pool
  // reserves on the next tick. We just need non-zero values that pass JSON.
  const position = {
    borrower,
    collateralToken: args.collateralToken,
    debtToken: args.debtToken,
    collateralAmount: args.collateralAmount,
    debtAmount: args.debtAmount,
    collateralPrice: 1.0,
    debtPrice: 1.0,
    liquidationThreshold: args.threshold,
  };

  await client.set(`loan:${id}`, JSON.stringify(position));
  await client.sadd("loans:registry", id);

  logger.info({ id, ...position },
    "Loan registered. Bot will read it on next tick + compute health from real pool prices.");

  await cache.disconnect();
}

main().catch((err) => {
  logger.error({ err: err.message || err }, "create_loan failed");
  process.exit(1);
});
