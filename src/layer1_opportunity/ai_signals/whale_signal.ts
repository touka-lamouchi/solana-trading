import { WhaleCache, WhaleState } from "../../cache/whale_cache";
import { logger } from "../../utils/logger";

export interface WhaleSignalResult {
  token: string;
  netDirection: "bullish" | "bearish" | "neutral" | "unknown";
  accumulatingCount: number;
  distributingCount: number;
  holdingCount: number;
  avgConfidence: number;
  topWhaleAction: WhaleState["action"];
  topWhaleAmount: number;
}

export class WhaleSignal {
  private whaleCache: WhaleCache;

  constructor(whaleCache: WhaleCache) {
    this.whaleCache = whaleCache;
  }

  async getSignal(tokenMint: string): Promise<WhaleSignalResult> {
    const whales = await this.whaleCache.getByToken(tokenMint);

    if (whales.length === 0) {
      return {
        token: tokenMint,
        netDirection: "unknown",
        accumulatingCount: 0,
        distributingCount: 0,
        holdingCount: 0,
        avgConfidence: 0,
        topWhaleAction: "unknown",
        topWhaleAmount: 0,
      };
    }

    const accumulating = whales.filter(w => w.action === "accumulating");
    const distributing = whales.filter(w => w.action === "distributing");
    const holding = whales.filter(w => w.action === "holding");

    const avgConfidence = whales.reduce((sum, w) => sum + w.confidence, 0) / whales.length;

    // Top whale = largest position
    const topWhale = whales.reduce((max, w) => w.amount > max.amount ? w : max, whales[0]!);

    // Net direction
    let netDirection: WhaleSignalResult["netDirection"] = "neutral";

    if (accumulating.length > distributing.length && avgConfidence > 0.5) {
      netDirection = "bullish";
    } else if (distributing.length > accumulating.length && avgConfidence > 0.5) {
      netDirection = "bearish";
    }

    const result: WhaleSignalResult = {
      token: tokenMint,
      netDirection,
      accumulatingCount: accumulating.length,
      distributingCount: distributing.length,
      holdingCount: holding.length,
      avgConfidence: parseFloat(avgConfidence.toFixed(3)),
      topWhaleAction: topWhale.action,
      topWhaleAmount: topWhale.amount,
    };

    logger.info({
      token: tokenMint.slice(0, 8) + "...",
      direction: netDirection,
      accumulating: accumulating.length,
      distributing: distributing.length,
      holding: holding.length,
    }, "Whale signal");

    return result;
  }
}
