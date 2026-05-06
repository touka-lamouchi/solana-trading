import { EventEmitter } from "events";
import { logger } from "../utils/logger";

export interface ClosedCandle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
  symbol: string;
  interval: string;
}

/**
 * CandleReactor — Binance WebSocket kline listener.
 *
 * Connects to the Binance public stream for a given symbol and interval.
 * When a candle CLOSES (kline.x === true) it emits a "candle_closed"
 * event with the candle data so the engine can immediately refresh the
 * AI decision model without waiting for the next poll cycle.
 *
 * No API key required — Binance public streams are unauthenticated.
 *
 * Events:
 *   "candle_closed"  (candle: ClosedCandle)
 *   "connected"      ()
 *   "disconnected"   ()
 *
 * The reactor auto-reconnects on unexpected disconnection with
 * exponential back-off (1s → 2s → 4s → … capped at 30s).
 */
export class CandleReactor extends EventEmitter {
  private symbol: string;
  private interval: string;
  private ws: any | null = null; // ws.WebSocket
  private running = false;
  private reconnectDelay = 1000;
  private readonly MAX_RECONNECT_DELAY = 30_000;

  constructor(opts: { symbol?: string; interval?: string }) {
    super();
    this.symbol = (opts.symbol ?? "solusdt").toLowerCase();
    this.interval = opts.interval ?? "1m";
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
    logger.info(
      { symbol: this.symbol, interval: this.interval },
      "CandleReactor started — connecting to Binance kline stream",
    );
  }

  stop(): void {
    this.running = false;
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    logger.info("CandleReactor stopped");
  }

  private connect(): void {
    if (!this.running) return;

    const url = `wss://stream.binance.com:9443/ws/${this.symbol}@kline_${this.interval}`;

    let WS: any;
    try {
      // ws is an optional peer dep — check at runtime
      WS = require("ws");
    } catch {
      logger.warn(
        "CandleReactor: 'ws' package not found — candle-driven AI refresh disabled. " +
        "Install with: npm install ws @types/ws",
      );
      this.running = false;
      return;
    }

    this.ws = new WS(url);

    this.ws.on("open", () => {
      this.reconnectDelay = 1000; // reset back-off on successful connect
      logger.info({ url }, "CandleReactor: connected to Binance");
      this.emit("connected");
    });

    this.ws.on("message", (data: Buffer | string) => {
      try {
        const msg = JSON.parse(data.toString());
        const k = msg.k;
        if (!k || !k.x) return; // x = candle closed; ignore in-progress candles

        const candle: ClosedCandle = {
          openTime:  k.t,
          open:      parseFloat(k.o),
          high:      parseFloat(k.h),
          low:       parseFloat(k.l),
          close:     parseFloat(k.c),
          volume:    parseFloat(k.v),
          closeTime: k.T,
          symbol:    k.s,
          interval:  k.i,
        };

        logger.debug(
          { symbol: candle.symbol, close: candle.close, volume: candle.volume.toFixed(0) },
          "CandleReactor: candle closed",
        );

        this.emit("candle_closed", candle);
      } catch (e: any) {
        logger.debug({ error: e.message }, "CandleReactor: failed to parse message");
      }
    });

    this.ws.on("error", (err: Error) => {
      logger.warn({ error: err.message }, "CandleReactor: WebSocket error");
    });

    this.ws.on("close", () => {
      this.ws = null;
      this.emit("disconnected");
      if (!this.running) return;
      logger.warn(
        { delay: this.reconnectDelay },
        "CandleReactor: disconnected — reconnecting",
      );
      setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.MAX_RECONNECT_DELAY);
    });
  }
}
