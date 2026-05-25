/**
 * binance_data.ts — fetch real historical klines from Binance for backtests.
 *
 * Uses the same public endpoint the live bot's IngestionService uses. No API
 * key required. Returns a simple typed candle series.
 *
 * If the network is unavailable, callers should fall back to a fixture so the
 * backtest still runs in CI (see test_arb_backtest.ts).
 */

export interface BTCandle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const BINANCE_URL = "https://api.binance.com/api/v3/klines";

/**
 * Fetch `limit` candles of `interval` for `symbol` (e.g. "SOLUSDT", "1h").
 * Binance kline array indices: [0]=openTime [1]=open [2]=high [3]=low
 * [4]=close [5]=volume.
 */
export async function fetchBinanceCandles(
  symbol = "SOLUSDT",
  interval = "1h",
  limit = 200,
): Promise<BTCandle[]> {
  const url = `${BINANCE_URL}?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance ${res.status}: ${await res.text()}`);
  const rows = (await res.json()) as unknown[][];
  return rows.map((r) => ({
    openTime: Number(r[0]),
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    volume: Number(r[5]),
  }));
}

/** Deterministic fallback series (a gentle sine wave around $150) for offline CI. */
export function syntheticCandles(n = 200): BTCandle[] {
  const out: BTCandle[] = [];
  const base = 150;
  for (let i = 0; i < n; i++) {
    const close = base + 20 * Math.sin(i / 8) + 5 * Math.sin(i / 2.3);
    const open = base + 20 * Math.sin((i - 1) / 8) + 5 * Math.sin((i - 1) / 2.3);
    out.push({
      openTime: i * 3600_000,
      open,
      high: Math.max(open, close) * 1.002,
      low: Math.min(open, close) * 0.998,
      close,
      volume: 1000 + 100 * Math.cos(i / 5),
    });
  }
  return out;
}
