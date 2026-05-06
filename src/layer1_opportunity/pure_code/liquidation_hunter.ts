import { Connection, PublicKey } from "@solana/web3.js";
import { logger } from "../../utils/logger";
import { getStrategyConfig } from "../../utils/config";
import { CacheManager } from "../../cache/cache_manager";
import type { LendingClient, DecodedPosition } from "../../layer2_execution/lending_client";

export interface LiquidationOpportunity {
  type: "liquidation";
  protocol: string;
  borrower: string;
  healthRatio: number;
  collateralToken: string;
  debtToken: string;
  collateralAmount: number;
  debtAmount: number;
  liquidationReward: number;
  timestamp: number;
  // On-chain metadata — present when position was loaded from programs-lending.
  // Consumed by executeLiquidation in trading_engine.ts to build the tx.
  positionPda?: string;
  collateralMint?: string;
  debtMint?: string;
}

export interface LoanPosition {
  borrower: string;
  collateralToken: string;
  debtToken: string;
  collateralAmount: number;
  debtAmount: number;
  collateralPrice: number;
  debtPrice: number;
  liquidationThreshold: number;
  // On-chain identity fields (undefined for legacy Redis positions)
  positionPda?: string;
  collateralMint?: string;
  debtMint?: string;
}

export class LiquidationHunter {
  private minReward: number;
  private positions: LoanPosition[] = [];
  private cache: CacheManager | null = null;
  private lendingClient: LendingClient | null = null;

  constructor(minReward?: number) {
    const cfg = getStrategyConfig();
    this.minReward = minReward ?? cfg.strategies.crypto_liquidation.min_reward_usd;
  }

  setCache(cache: CacheManager): void {
    this.cache = cache;
  }

  setLendingClient(client: LendingClient): void {
    this.lendingClient = client;
  }

  // Load positions from the programs-lending Anchor program.
  // Each DecodedPosition is mapped to a LoanPosition with on-chain identity
  // fields (positionPda, collateralMint, debtMint) for use in execution.
  async loadFromChain(
    tokenNameByMint: Record<string, string>,
  ): Promise<void> {
    if (!this.lendingClient) return;
    try {
      const onChain: DecodedPosition[] = await this.lendingClient.getActivePositions();
      const fresh: LoanPosition[] = onChain.map(pos => ({
        borrower: pos.borrower.toBase58(),
        collateralToken: tokenNameByMint[pos.collateralMint.toBase58()] ?? pos.collateralMint.toBase58(),
        debtToken: tokenNameByMint[pos.debtMint.toBase58()] ?? pos.debtMint.toBase58(),
        // Convert raw lamports/units to human amounts with 9 decimals for fSOL, 6 for fUSDC.
        // The execution path reads back collateralAmount from the opportunity for profit calc.
        collateralAmount: Number(pos.collateralAmount),
        debtAmount: Number(pos.debtAmount),
        collateralPrice: 1.0,
        debtPrice: 1.0,
        liquidationThreshold: Number(pos.thresholdBps) / 10_000,
        positionPda: pos.pda.toBase58(),
        collateralMint: pos.collateralMint.toBase58(),
        debtMint: pos.debtMint.toBase58(),
      }));
      this.positions = fresh;
      logger.debug({ count: fresh.length }, "LiquidationHunter: loaded positions from chain");
    } catch (e: any) {
      logger.warn({ error: e.message }, "LiquidationHunter: failed to load from chain");
    }
  }

  // Fallback: load positions from the Redis registry (legacy create_loan.ts flow).
  async loadFromRedis(): Promise<void> {
    if (!this.cache) return;
    try {
      const client = this.cache.getClient();
      const ids = await client.smembers("loans:registry");
      const fresh: LoanPosition[] = [];
      for (const id of ids) {
        const raw = await client.get(`loan:${id}`);
        if (!raw) continue;
        try {
          const p = JSON.parse(raw) as LoanPosition;
          fresh.push(p);
        } catch { /* skip malformed */ }
      }
      this.positions = fresh;
    } catch (e: any) {
      logger.warn({ error: e.message }, "LiquidationHunter: failed to load positions from Redis");
    }
  }

  // Update collateral/debt prices from live pool reserve ratios.
  applyPrices(priceMap: Record<string, number>): void {
    for (const p of this.positions) {
      const cp = priceMap[p.collateralToken];
      const dp = priceMap[p.debtToken];
      if (cp !== undefined && cp > 0) p.collateralPrice = cp;
      if (dp !== undefined && dp > 0) p.debtPrice = dp;
    }
  }

  calculateHealthRatio(position: LoanPosition): number {
    const collateralValue = position.collateralAmount * position.collateralPrice;
    const debtValue = position.debtAmount * position.debtPrice;
    if (debtValue === 0) return Infinity;
    return collateralValue / debtValue;
  }

  loadSimulatedPositions(positions: LoanPosition[]): void {
    this.positions = positions;
    logger.info({ count: positions.length }, "Loaded loan positions");
  }

  getPositions(): LoanPosition[] {
    return this.positions;
  }

  refresh(_maxDriftPct = 0.03): void {
    /* deprecated: prices now come from real pool reserves */
  }

  scan(): LiquidationOpportunity[] {
    const opportunities: LiquidationOpportunity[] = [];

    for (const position of this.positions) {
      const healthRatio = this.calculateHealthRatio(position);

      if (healthRatio < position.liquidationThreshold) {
        const collateralValue = position.collateralAmount * position.collateralPrice;
        const debtValue = position.debtAmount * position.debtPrice;
        const liquidationReward = collateralValue - debtValue;

        if (liquidationReward >= this.minReward) {
          const opp: LiquidationOpportunity = {
            type: "liquidation",
            protocol: position.positionPda ? "programs-lending" : "simulated-lending",
            borrower: position.borrower,
            healthRatio,
            collateralToken: position.collateralToken,
            debtToken: position.debtToken,
            collateralAmount: position.collateralAmount,
            debtAmount: position.debtAmount,
            liquidationReward,
            timestamp: Date.now(),
            ...(position.positionPda ? { positionPda: position.positionPda } : {}),
            ...(position.collateralMint ? { collateralMint: position.collateralMint } : {}),
            ...(position.debtMint ? { debtMint: position.debtMint } : {}),
          };

          opportunities.push(opp);
          logger.info({
            borrower: position.borrower,
            positionPda: position.positionPda?.slice(0, 12),
            healthRatio: healthRatio.toFixed(4),
            reward: liquidationReward.toFixed(2),
            onChain: !!position.positionPda,
          }, "LIQUIDATION FOUND");
        }
      }
    }

    if (opportunities.length === 0) {
      logger.info("No liquidatable positions found");
    }

    return opportunities;
  }
}
