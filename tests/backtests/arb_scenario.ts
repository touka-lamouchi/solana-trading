/**
 * arb_scenario.ts — shared triangle-pool construction + a single-candle arb
 * detection step, reused by all arbitrage backtests (base, fee sweep, walk-forward).
 *
 * Builds a 3-pool triangle (USDC/SOL, SOL/RAY, RAY/USDC) where USDC/SOL tracks a
 * live price and RAY/USDC lags, creating realistic transient triangular arbs.
 * Runs the SAME pure code the live ArbReactor uses.
 */

import { findRankedCycles, cycleLabel } from "../../src/layer1_opportunity/pure_code/arb_graph_builder";
import type { PoolRecord } from "../../src/layer1_opportunity/pure_code/pool_registry";

export const USDC = "USDCmint1111111111111111111111111111111111";
export const SOL = "SOLmint11111111111111111111111111111111111";
export const RAY = "RAYmint11111111111111111111111111111111111";
export const RAY_USD = 2.0;

export function buildTriangle(solPrice: number, laggedSolPrice: number): PoolRecord[] {
  const fee = { feeNumerator: 997, feeDenominator: 1000 };
  const dec = { decimalsA: 6, decimalsB: 6 };
  const base = { vaultA: "v", vaultB: "v", ...fee, ...dec, updatedAt: Date.now() };
  const DEPTH = 1_000_000;
  const solInRay = solPrice / RAY_USD;

  return [
    { ...base, poolKey: "P1_USDC_SOL", mintA: USDC, mintB: SOL, symbolA: "USDC", symbolB: "SOL",
      reserveA: DEPTH, reserveB: DEPTH / solPrice },
    { ...base, poolKey: "P2_SOL_RAY", mintA: SOL, mintB: RAY, symbolA: "SOL", symbolB: "RAY",
      reserveA: DEPTH / solPrice, reserveB: (DEPTH / solPrice) * solInRay },
    { ...base, poolKey: "P3_RAY_USDC", mintA: RAY, mintB: USDC, symbolA: "RAY", symbolB: "USDC",
      reserveA: (DEPTH / RAY_USD) * (solPrice / laggedSolPrice), reserveB: DEPTH },
  ];
}

export interface ArbHit {
  index: number;
  found: boolean;
  label?: string;
  amountIn?: number;
  netProfit?: number;
}

/** Detect the best triangular arb for one candle given a fee gate. */
export function detectArb(
  solPrice: number,
  laggedSolPrice: number,
  index: number,
  opts: { estimatedFeeBase: number; minProfitMultiplier: number },
): ArbHit {
  const pools = buildTriangle(solPrice, laggedSolPrice);
  const ranked = findRankedCycles(pools, {
    baseMint: USDC,
    minIn: 10,
    maxIn: 100_000,
    estimatedFeeBase: opts.estimatedFeeBase,
    minProfitMultiplier: opts.minProfitMultiplier,
    minDepth: 3,
    maxDepth: 3,
  });
  if (ranked.length === 0) return { index, found: false };
  const best = ranked[0]!;
  return {
    index,
    found: true,
    label: cycleLabel(best.cycle),
    amountIn: best.amountIn,
    netProfit: best.netProfit,
  };
}
