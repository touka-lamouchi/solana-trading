import { MempoolMonitor } from "../../infrastructure/mempool_monitor";
import { logger } from "../../utils/logger";

export interface MempoolSignalResult {
  token: string;
  pressureScore: number;     // -1 (extreme sell) to +1 (extreme buy)
  netDirection: "bullish" | "bearish" | "neutral" | "unknown";
  buyTxCount: number;
  sellTxCount: number;
  buyVolume: number;
  sellVolume: number;
}

export class MempoolSignal {
  private monitor: MempoolMonitor;

  constructor(monitor: MempoolMonitor) {
    this.monitor = monitor;
  }

  async getSignal(tokenMint: string): Promise<MempoolSignalResult> {
    const pressure = await this.monitor.getPressure(tokenMint);

    if (!pressure) {
      return {
        token: tokenMint,
        pressureScore: 0,
        netDirection: "unknown",
        buyTxCount: 0,
        sellTxCount: 0,
        buyVolume: 0,
        sellVolume: 0,
      };
    }

    let netDirection: MempoolSignalResult["netDirection"] = "neutral";
    if (pressure.pressureScore > 0.2) netDirection = "bullish";
    else if (pressure.pressureScore < -0.2) netDirection = "bearish";

    const result: MempoolSignalResult = {
      token: tokenMint,
      pressureScore: pressure.pressureScore,
      netDirection,
      buyTxCount: pressure.buyTxCount,
      sellTxCount: pressure.sellTxCount,
      buyVolume: pressure.buyVolume,
      sellVolume: pressure.sellVolume,
    };

    logger.info({
      token: tokenMint.slice(0, 8) + "...",
      direction: netDirection,
      pressure: pressure.pressureScore,
      buys: pressure.buyTxCount,
      sells: pressure.sellTxCount,
    }, "Mempool signal");

    return result;
  }
}
