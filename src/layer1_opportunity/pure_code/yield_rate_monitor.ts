import { logger } from "../../utils/logger";
import { getStrategyConfig } from "../../utils/config";

export interface YieldOpportunity {
  type: "yield";
  fromProtocol: string;
  toProtocol: string;
  token: string;
  currentApy: number;
  targetApy: number;
  apyDifference: number;
  timestamp: number;
}

export interface ProtocolYield {
  protocol: string;
  token: string;
  apy: number;           // annual percentage yield
  tvl: number;           // total value locked
  lastUpdated: number;
}

export class YieldRateMonitor {
  private minApyDifference: number;
  private yields: ProtocolYield[] = [];

  constructor(minApyDifference?: number) {
    const cfg = getStrategyConfig();
    this.minApyDifference = minApyDifference ?? cfg.strategies.crypto_yield_farming.min_apy_diff_pct;
  }

  // Load yield data (in production, reads from DeFi protocols)
  // For devnet, we simulate yields
  loadSimulatedYields(yields: ProtocolYield[]): void {
    this.yields = yields;
    logger.info({ count: yields.length }, "Loaded protocol yields");
  }

  // Find yield opportunities — where one protocol offers significantly more
  scan(): YieldOpportunity[] {
    const opportunities: YieldOpportunity[] = [];

    // Group yields by token
    const byToken: Record<string, ProtocolYield[]> = {};
    for (const y of this.yields) {
      if (!byToken[y.token]) byToken[y.token] = [];
      byToken[y.token]!.push(y);
    }

    // Compare yields within each token
    for (const token of Object.keys(byToken)) {
      const tokenYields = byToken[token]!;
      if (tokenYields.length < 2) continue;

      // Sort by APY ascending
      tokenYields.sort((a, b) => a.apy - b.apy);

      const lowest = tokenYields[0]!;
      const highest = tokenYields[tokenYields.length - 1]!;
      const diff = highest.apy - lowest.apy;

      if (diff >= this.minApyDifference) {
        const opp: YieldOpportunity = {
          type: "yield",
          fromProtocol: lowest.protocol,
          toProtocol: highest.protocol,
          token,
          currentApy: lowest.apy,
          targetApy: highest.apy,
          apyDifference: diff,
          timestamp: Date.now(),
        };

        opportunities.push(opp);
        logger.info({
          token,
          from: `${lowest.protocol} (${lowest.apy}%)`,
          to: `${highest.protocol} (${highest.apy}%)`,
          diff: diff.toFixed(2) + "%",
        }, "YIELD GAP FOUND");
      }
    }

    if (opportunities.length === 0) {
      logger.info("No significant yield differences found");
    }

    return opportunities;
  }
}
