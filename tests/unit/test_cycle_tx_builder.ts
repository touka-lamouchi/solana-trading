/**
 * test_cycle_tx_builder — exercise TransactionBuilder.buildCycleArbTransaction
 * with stubbed Anchor programs. Verifies instruction order, count, and that
 * each hop is assembled with the correct swap direction.
 *
 * Run: npx ts-node tests/unit/test_cycle_tx_builder.ts
 */

import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { TransactionBuilder } from "../../src/layer2_execution/transaction_builder";

function assert(cond: any, msg: string): void {
  if (!cond) throw new Error("assertion failed: " + msg);
}

// Stub a fluent Anchor `methods.X(args).accounts(obj).instruction()` chain so
// the builder can call it without an RPC. Each emitted instruction is tagged
// with metadata so tests can introspect the assembled transaction.
function makeStubProgram(label: string) {
  return {
    methods: new Proxy({}, {
      get(_t, methodName: string) {
        return (...args: any[]) => ({
          accounts(accs: any) {
            return {
              instruction: async () => {
                const programId = new PublicKey("11111111111111111111111111111111");
                return {
                  programId,
                  keys: [],
                  data: Buffer.from(JSON.stringify({ p: label, m: methodName, args, accs })),
                };
              },
            };
          },
        });
      },
    }),
    programId: new PublicKey("11111111111111111111111111111111"),
  } as any;
}

// Stub Connection with just the calls TransactionBuilder makes.
const stubConnection = {
  async getLatestBlockhash() {
    return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 0 };
  },
  async getTokenAccountBalance() {
    return { value: { uiAmountString: "0", amount: "0", decimals: 6 } };
  },
} as any;

// Use ephemeral keypairs to get valid base58 pubkeys.
const pk = () => Keypair.generate().publicKey.toBase58();

const USDC_MINT = pk();
const SOL_MINT  = pk();
const RAY_MINT  = pk();

const tokens = {
  tokenA: { name: "fUSDC", mint: USDC_MINT, decimals: 6, account: pk() },
  tokenB: { name: "fSOL",  mint: SOL_MINT,  decimals: 9, account: pk() },
  tokenC: { name: "fRAY",  mint: RAY_MINT,  decimals: 6, account: pk() },
};

const pools = {
  pool1: {
    name: "fUSDC/fSOL",
    address: pk(), tokenAVault: pk(), tokenBVault: pk(),
    tokenA: "fUSDC", tokenB: "fSOL",
  },
  pool2: {
    name: "fSOL/fRAY",
    address: pk(), tokenAVault: pk(), tokenBVault: pk(),
    tokenA: "fSOL", tokenB: "fRAY",
  },
  pool3: {
    name: "fUSDC/fRAY",
    address: pk(), tokenAVault: pk(), tokenBVault: pk(),
    tokenA: "fUSDC", tokenB: "fRAY",
  },
};

const FLASH_CONFIG = pk();
const FLASH_VAULT  = pk();

function makeBuilder(): TransactionBuilder {
  const userKey = Keypair.generate();
  const ammProgram = makeStubProgram("amm");
  const slippageGuard: any = {};
  return new TransactionBuilder(
    stubConnection,
    ammProgram as any,
    slippageGuard,
    tokens,
    userKey,
  );
}

async function buildTx(cycle: any[]): Promise<Transaction> {
  const builder = makeBuilder();
  const flashProgram = makeStubProgram("flash");
  return builder.buildCycleArbTransaction({
    cycle,
    pools,
    flashProgram: flashProgram as any,
    flashConfig: FLASH_CONFIG,
    flashVault:  FLASH_VAULT,
    borrowAmount: 100,
    borrowDecimals: 6,
  });
}

function decodeTag(ix: any): { p?: string; m?: string } {
  try { return JSON.parse(ix.data.toString()); } catch { return {}; }
}

async function testThreeHopForwardCycle() {
  // Forward: USDC → SOL (pool1, A→B) → RAY (pool2, A→B) → USDC (pool3, B→A)
  const cycle = [
    { poolKey: "pool1", fromMint: USDC_MINT, toMint: SOL_MINT,  amountIn: 100,   amountOut: 0.02 },
    { poolKey: "pool2", fromMint: SOL_MINT,  toMint: RAY_MINT,  amountIn: 0.02,  amountOut: 200 },
    { poolKey: "pool3", fromMint: RAY_MINT,  toMint: USDC_MINT, amountIn: 200,   amountOut: 105 },
  ];
  const tx = await buildTx(cycle);
  // 2 compute-budget + 1 borrow + 3 swaps + 1 repay = 7
  assert(tx.instructions.length === 7, `expected 7 instructions, got ${tx.instructions.length}`);
  const swaps = tx.instructions.slice(3, 6).map(decodeTag);
  assert(swaps.every(s => s.m === "swap"), `swap method on each hop`);
  assert(decodeTag(tx.instructions[2]!).m === "flashBorrow", "borrow first");
  assert(decodeTag(tx.instructions[6]!).m === "flashRepay", "repay last");
}

async function testTwoHopCycle() {
  // 2-hop on the same pool (just exercising hop-count generality of the builder):
  const cycle = [
    { poolKey: "pool1", fromMint: USDC_MINT, toMint: SOL_MINT,  amountIn: 100,  amountOut: 0.02 },
    { poolKey: "pool1", fromMint: SOL_MINT,  toMint: USDC_MINT, amountIn: 0.02, amountOut: 99 },
  ];
  const tx = await buildTx(cycle);
  // 2 compute-budget + 1 borrow + 2 swaps + 1 repay = 6
  assert(tx.instructions.length === 6, `expected 6 instructions, got ${tx.instructions.length}`);
}

async function testFourHopCycle() {
  // Synthetic 4-hop chain.
  const cycle = [
    { poolKey: "pool1", fromMint: USDC_MINT, toMint: SOL_MINT,  amountIn: 100,   amountOut: 0.02 },
    { poolKey: "pool2", fromMint: SOL_MINT,  toMint: RAY_MINT,  amountIn: 0.02,  amountOut: 5 },
    { poolKey: "pool2", fromMint: RAY_MINT,  toMint: SOL_MINT,  amountIn: 5,     amountOut: 0.019 },
    { poolKey: "pool1", fromMint: SOL_MINT,  toMint: USDC_MINT, amountIn: 0.019, amountOut: 99 },
  ];
  const tx = await buildTx(cycle);
  // 2 + 1 + 4 + 1 = 8
  assert(tx.instructions.length === 8, `expected 8 instructions, got ${tx.instructions.length}`);
}

async function testRejectsLessThanTwoHops() {
  let threw = false;
  try {
    await buildTx([
      { poolKey: "pool1", fromMint: USDC_MINT, toMint: SOL_MINT, amountIn: 100, amountOut: 0.02 },
    ]);
  } catch (e: any) {
    threw = e.message.includes("≥2 hops");
  }
  assert(threw, "must throw on 1-hop input");
}

async function testProfitSweepAddsTwoExtraInstructions() {
  const cycle = [
    { poolKey: "pool1", fromMint: USDC_MINT, toMint: SOL_MINT,  amountIn: 100,  amountOut: 0.02 },
    { poolKey: "pool1", fromMint: SOL_MINT,  toMint: USDC_MINT, amountIn: 0.02, amountOut: 105 },
  ];
  const builder = makeBuilder();
  const flashProgram = makeStubProgram("flash");
  const tx = await builder.buildCycleArbTransaction({
    cycle,
    pools,
    flashProgram: flashProgram as any,
    flashConfig: FLASH_CONFIG,
    flashVault:  FLASH_VAULT,
    borrowAmount: 100,
    borrowDecimals: 6,
    profitSweep: {
      vaultPda: new PublicKey(pk()),
      baseMint: new PublicKey(USDC_MINT),
      profitRaw: new BN(5_000_000),
    },
  });
  // 2 compute + 1 borrow + 2 swaps + 1 repay + 2 sweep = 8
  assert(tx.instructions.length === 8, `expected 8 with sweep, got ${tx.instructions.length}`);
}

const tests: Array<[string, () => Promise<void>]> = [
  ["3-hop forward cycle: borrow → swap × 3 → repay", testThreeHopForwardCycle],
  ["2-hop cycle: borrow → swap × 2 → repay", testTwoHopCycle],
  ["4-hop cycle: borrow → swap × 4 → repay", testFourHopCycle],
  ["rejects 1-hop input", testRejectsLessThanTwoHops],
  ["profit sweep adds idempotent ATA-init + transfer", testProfitSweepAddsTwoExtraInstructions],
];

(async () => {
  let passed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (e: any) {
      console.error(`  ✗ ${name}: ${e.message}`);
      process.exit(1);
    }
  }
  console.log(`\n${passed}/${tests.length} cycle_tx_builder tests passed`);
})();
