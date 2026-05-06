import * as https from "https";
import { getConfig } from "../../utils/config";
import { logger } from "../../utils/logger";

export interface PythPrice {
  price: number;
  confidence: number;
  publishTime: number;
}

// Pyth Hermes off-chain price service — HTTP GET, no API key.
// Docs: https://hermes.pyth.network/docs
export class PythFeed {
  private hermesUrl: string;
  private solFeedId: string;

  constructor() {
    const cfg = getConfig();
    this.hermesUrl = cfg.pyth?.hermes_url ?? "https://hermes.pyth.network";
    this.solFeedId = cfg.pyth?.sol_usd_feed_id
      ?? "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
  }

  async fetchSolUsd(): Promise<PythPrice | null> {
    const url = `${this.hermesUrl}/v2/updates/price/latest?ids[]=${this.solFeedId}`;
    try {
      const body = await this.httpGet(url);
      const json = JSON.parse(body);
      const parsed = json?.parsed?.[0]?.price;
      if (!parsed) {
        logger.warn("Pyth: empty response");
        return null;
      }
      const price = Number(parsed.price) * Math.pow(10, Number(parsed.expo));
      const conf = Number(parsed.conf) * Math.pow(10, Number(parsed.expo));
      return {
        price,
        confidence: conf,
        publishTime: Number(parsed.publish_time) * 1000,
      };
    } catch (e: any) {
      logger.warn({ error: e.message }, "Pyth fetch failed");
      return null;
    }
  }

  private httpGet(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = https.get(url, { timeout: 5000 }, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      });
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Pyth HTTP timeout"));
      });
    });
  }
}
