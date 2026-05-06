/**
 * Shared helpers for discovery nodes.
 *
 * Utility functions used by multiple nodes to avoid duplication.
 * All functions are pure — no deps injection, no side effects.
 */

import type { PoolState } from "../../layer1_opportunity/pure_code/arbitrage_detector";
import type { ValidPool } from "../state";
import type { DiscoveredOpportunity } from "../../engine/arb_reactor";
import type { ArbOpportunity } from "../../layer1_opportunity/pure_code/arbitrage_detector";
import type { DecisionResult } from "../../layer1_opportunity/decision_model";
import { getConfig } from "../../utils/config";

// Resolve the signal mint — mainnet wSOL when ai.data_source=mainnet, else tradeMint.
export function resolveSignalMint(tokens: any): string {
  const cfg = getConfig();
  return (cfg.ai?.data_source === "mainnet" && cfg.ai?.target_mint_mainnet)
    ? cfg.ai.target_mint_mainnet
    : (tokens.tokenB?.mint ?? "");
}

// Max borrow amount capped by settings.
export function borrowCap(): number {
  const cfg = getConfig();
  return Math.min(100, cfg.capital?.flash_loan_max_usd ?? 100);
}

// Find the first ValidPool whose config has the given token name (tokenA or tokenB).
export function findPoolWithToken(
  tokenName: string,
  validPools: ValidPool[],
): ValidPool | null {
  for (const vp of validPools) {
    if (vp.pool?.tokenA === tokenName || vp.pool?.tokenB === tokenName) return vp;
  }
  return null;
}

// Non-base mints for a pool — used to populate involvedMints.
export function involvedMints(pool: any, tokens: any, baseMint: string): string[] {
  const mintA: string = pool?.tokenAMint ?? resolveMintByName(pool?.tokenA, tokens) ?? "";
  const mintB: string = pool?.tokenBMint ?? resolveMintByName(pool?.tokenB, tokens) ?? "";
  const result: string[] = [];
  if (mintA && mintA !== baseMint) result.push(mintA);
  if (mintB && mintB !== baseMint) result.push(mintB);
  return result;
}

function resolveMintByName(name: string | undefined, tokens: any): string | undefined {
  if (!name) return undefined;
  for (const key of Object.keys(tokens)) {
    if (tokens[key]?.name === name) return tokens[key].mint;
  }
  return undefined;
}

// Wrap a raw ArbOpportunity into a DiscoveredOpportunity for signal-based detectors.
// These always target pool1 (fUSDC/fSOL) on the devnet trade side.
export function wrapSignalOpp(
  arb: ArbOpportunity,
  p1: PoolState,
  tradeMint: string,
): DiscoveredOpportunity {
  return {
    arb,
    poolStates: [p1],
    involvedMints: [tradeMint],
    poolKeys: ["pool1"],
    isTriangular: false,
  };
}

// Build a directional opportunity from an AI decision + pool1 state.
export function buildDirectionalOpp(
  decision: DecisionResult,
  p1: PoolState,
  tokens: any,
): DiscoveredOpportunity {
  const cap = Math.min(borrowCap(), 200);
  const tradeMint: string = tokens.tokenB?.mint ?? "";
  const direction = decision.direction;

  const arb: ArbOpportunity = {
    type: "directional",
    path: `directional: ${direction} aiScore=${decision.aiScore.toFixed(2)}`,
    tokenIn: direction === "bullish" ? "fUSDC" : "fSOL",
    tokenOut: direction === "bullish" ? "fSOL" : "fUSDC",
    amountIn: cap,
    expectedProfit: cap * decision.aiScore * 0.01,
    profitPercent: decision.aiScore * 1,
    pools: [p1],
    timestamp: Date.now(),
  };

  return {
    arb,
    poolStates: [p1],
    involvedMints: [tradeMint],
    poolKeys: ["pool1"],
    isTriangular: false,
  };
}
