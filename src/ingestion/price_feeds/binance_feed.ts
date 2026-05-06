import * as https from "https";
import { getConfig } from "../../utils/config";
import { logger } from "../../utils/logger";
import { Candle } from "../candle_fetcher";

// Binance public REST — no API key. Docs: GET /api/v3/klines
// Response shape (per kline):
//   [openTime, open, high, low, close, volume, closeTime, quoteVolume, ...]
export class BinanceFeed {
  private baseUrl: string;
  private symbol: string;
  private interval: string;

  constructor() {
    const cfg = getConfig();
    this.baseUrl = cfg.binance?.base_url ?? "https://api.binance.com";
    this.symbol = cfg.binance?.symbol ?? "SOLUSDT";
    this.interval = cfg.binance?.interval ?? "1h";
  }

  async fetchKlines(limit = 24): Promise<Candle[]> {
    const url = `${this.baseUrl}/api/v3/klines?symbol=${this.symbol}&interval=${this.interval}&limit=${limit}`;
    try {
      const body = await this.httpGet(url);
      const rows: any[] = JSON.parse(body);
      if (!Array.isArray(rows)) {
        logger.warn({ body: body.slice(0, 200) }, "Binance: unexpected response");
        return [];
      }
      return rows.map((r) => ({
        timestamp: Number(r[0]),
        open: parseFloat(r[1]),
        high: parseFloat(r[2]),
        low: parseFloat(r[3]),
        close: parseFloat(r[4]),
        volume: parseFloat(r[5]),
      }));
    } catch (e: any) {
      logger.warn({ error: e.message }, "Binance fetch failed");
      return [];
    }
  }

  private httpGet(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = https.get(url, { timeout: 7000 }, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      });
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Binance HTTP timeout"));
      });
    });
  }
}
