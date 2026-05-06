import { CacheManager } from "../cache/cache_manager";
import { logger } from "../utils/logger";

/**
 * NewsFeedMonitor — polls free, no-key sources for crypto + geopolitics
 * headlines, scores them via the Python AI server, and writes rolling
 * windows to Redis.
 *
 * Sources:
 *   - Crypto:       CoinDesk RSS, Cointelegraph RSS (+ /tag/<symbol>)
 *                   Optional: CryptoPanic if CRYPTOPANIC_TOKEN env is set
 *                   (their public free key still works for some accounts)
 *   - Geopolitics:  GDELT 2.0 DOC API (no key) + Reuters World RSS fallback
 *
 * Redis layout:
 *   news:crypto:<symbol>     → JSON { score, magnitude, count, headlines[], updatedAt }
 *   news:geopolitics:global  → JSON { score, magnitude, count, headlines[], updatedAt }
 *
 * Headlines fetched in this window are scored as a batch through
 * /predict/news-sentiment so we reuse the existing Gemini/VADER pipeline.
 */

export interface NewsItem {
  title: string;
  source: string;
  publishedAt: number; // ms epoch
  url?: string;
}

export interface NewsScore {
  score: number;       // -1..+1
  magnitude: number;   // 0..1, |score| weighted by recency
  count: number;
  headlines: string[]; // top 5 for debugging
  updatedAt: number;
}

interface AIClient {
  scoreNews(headlines: string[]): Promise<{ score: number; magnitude: number } | null>;
}

interface MonitorOptions {
  cache: CacheManager;
  aiClient: AIClient;
  cryptoSymbol: string;        // e.g. "SOL" or "solana"
  cryptoPollMs?: number;       // default 60s
  geoPollMs?: number;          // default 120s
  geoKeywords?: string[];      // default macro/regulation list
  recencyDecayMin?: number;    // default 60min
}

const DEFAULT_GEO_KEYWORDS = [
  "crypto regulation",
  "sec crypto",
  "fed rate",
  "sanctions",
  "etf approval",
];

export class NewsFeedMonitor {
  private cache: CacheManager;
  private ai: AIClient;
  private symbol: string;
  private cryptoPollMs: number;
  private geoPollMs: number;
  private geoKeywords: string[];
  private recencyDecayMin: number;

  private cryptoTimer: ReturnType<typeof setInterval> | null = null;
  private geoTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(opts: MonitorOptions) {
    this.cache = opts.cache;
    this.ai = opts.aiClient;
    this.symbol = opts.cryptoSymbol.toLowerCase();
    this.cryptoPollMs = opts.cryptoPollMs ?? 60_000;
    this.geoPollMs = opts.geoPollMs ?? 120_000;
    this.geoKeywords = opts.geoKeywords ?? DEFAULT_GEO_KEYWORDS;
    this.recencyDecayMin = opts.recencyDecayMin ?? 60;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // First runs in parallel, no await — don't block boot
    this.tickCrypto().catch((e) => logger.warn({ err: e?.message }, "news crypto first poll failed"));
    this.tickGeo().catch((e) => logger.warn({ err: e?.message }, "news geo first poll failed"));

    this.cryptoTimer = setInterval(() => {
      this.tickCrypto().catch(() => {});
    }, this.cryptoPollMs);
    this.geoTimer = setInterval(() => {
      this.tickGeo().catch(() => {});
    }, this.geoPollMs);

    logger.info(
      { symbol: this.symbol, cryptoMs: this.cryptoPollMs, geoMs: this.geoPollMs },
      "NewsFeedMonitor started",
    );
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.cryptoTimer) clearInterval(this.cryptoTimer);
    if (this.geoTimer) clearInterval(this.geoTimer);
    this.cryptoTimer = null;
    this.geoTimer = null;
    logger.info("NewsFeedMonitor stopped");
  }

  // ── Crypto tick ───────────────────────────────────────────

  private async tickCrypto(): Promise<void> {
    const items: NewsItem[] = [];

    const [coindesk, cointelegraph, panic] = await Promise.all([
      this.fetchRss("https://www.coindesk.com/arc/outboundfeeds/rss/", "coindesk"),
      this.fetchRss(`https://cointelegraph.com/rss/tag/${this.symbol}`, "cointelegraph")
        .then((r) => r.length > 0 ? r : this.fetchRss("https://cointelegraph.com/rss", "cointelegraph")),
      this.fetchCryptoPanic(),
    ]);

    items.push(...coindesk, ...cointelegraph, ...panic);

    // Filter by symbol mention (CoinDesk/Cointelegraph fallback returns broad crypto news)
    const filtered = this.filterBySymbol(items, this.symbol);
    const fresh = this.filterFresh(filtered.length > 0 ? filtered : items, 6 * 60); // last 6h

    await this.scoreAndStore(`news:crypto:${this.symbol}`, fresh);
  }

  // ── Geopolitics tick ──────────────────────────────────────

  private async tickGeo(): Promise<void> {
    // Run sources in parallel so a slow/empty source doesn't starve the others.
    // Reuters' public RSS was retired in 2022; BBC + Al Jazeera are still live.
    const [gdelt, bbc, aljazeera] = await Promise.all([
      this.fetchGdelt(this.geoKeywords),
      this.fetchRss("https://feeds.bbci.co.uk/news/world/rss.xml", "bbc"),
      this.fetchRss("https://www.aljazeera.com/xml/rss/all.xml", "aljazeera"),
    ]);

    // For RSS world feeds we want only items mentioning our geo keywords —
    // otherwise we'd score random sports/entertainment headlines as "geopolitics".
    const rssFiltered = [...bbc, ...aljazeera].filter((i) => {
      const t = i.title.toLowerCase();
      return this.geoKeywords.some((kw) => t.includes(kw.toLowerCase()))
          || /crypto|bitcoin|sec |fed |rate|sanction|tariff|war|conflict|regulat/i.test(i.title);
    });

    const merged = [...gdelt, ...rssFiltered];
    const items = this.filterFresh(merged, 24 * 60); // last 24h — geopolitics moves slower than crypto

    logger.info(
      { gdeltCount: gdelt.length, bbcCount: bbc.length, ajCount: aljazeera.length, rssFiltered: rssFiltered.length, kept: items.length },
      "news geo sources",
    );

    await this.scoreAndStore("news:geopolitics:global", items);
  }

  // ── Score + persist ───────────────────────────────────────

  private async scoreAndStore(key: string, items: NewsItem[]): Promise<void> {
    if (items.length === 0) {
      const empty: NewsScore = { score: 0, magnitude: 0, count: 0, headlines: [], updatedAt: Date.now() };
      await this.cache.getClient().set(key, JSON.stringify(empty), "EX", 600);
      return;
    }

    const headlines = items.map((i) => i.title).slice(0, 30);
    const ai = await this.ai.scoreNews(headlines).catch(() => null);

    let score = 0;
    let magnitude = 0;

    if (ai) {
      // Apply recency decay across the items as a magnitude shaper
      const now = Date.now();
      const decayWeights = items.slice(0, 30).map((i) => {
        const ageMin = (now - i.publishedAt) / 60_000;
        return Math.exp(-ageMin / this.recencyDecayMin);
      });
      const recencyAvg = decayWeights.length > 0
        ? decayWeights.reduce((a, b) => a + b, 0) / decayWeights.length
        : 0;

      score = ai.score;
      magnitude = Math.min(1, Math.abs(ai.score) * recencyAvg * (0.5 + Math.min(items.length, 20) / 40));
    }

    const entry: NewsScore = {
      score: parseFloat(score.toFixed(4)),
      magnitude: parseFloat(magnitude.toFixed(4)),
      count: items.length,
      headlines: headlines.slice(0, 5),
      updatedAt: Date.now(),
    };

    await this.cache.getClient().set(key, JSON.stringify(entry), "EX", 600);

    logger.info(
      { key, score: entry.score, magnitude: entry.magnitude, count: entry.count },
      "News scored",
    );
  }

  // ── Sources ───────────────────────────────────────────────

  private async fetchRss(url: string, source: string): Promise<NewsItem[]> {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "SolanaTradingBot/1.0" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return [];
      const xml = await res.text();
      return this.parseRss(xml, source);
    } catch (e: any) {
      logger.debug({ url, err: e?.message }, "RSS fetch failed");
      return [];
    }
  }

  private parseRss(xml: string, source: string): NewsItem[] {
    const items: NewsItem[] = [];
    // Match <item>...</item> blocks (RSS) or <entry>...</entry> (Atom)
    const blocks = xml.match(/<(item|entry)[\s\S]*?<\/(item|entry)>/g) ?? [];
    for (const block of blocks.slice(0, 25)) {
      const title = this.extractTag(block, "title");
      const pubDateRaw = this.extractTag(block, "pubDate") || this.extractTag(block, "published") || this.extractTag(block, "updated");
      const link = this.extractTag(block, "link");
      if (!title) continue;
      const ts = pubDateRaw ? Date.parse(pubDateRaw) : Date.now();
      items.push({
        title: this.cleanText(title),
        source,
        publishedAt: isNaN(ts) ? Date.now() : ts,
        url: link,
      });
    }
    return items;
  }

  private extractTag(block: string, tag: string): string {
    // CDATA-aware
    const cdata = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, "i");
    const plain = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
    return (block.match(cdata)?.[1] ?? block.match(plain)?.[1] ?? "").trim();
  }

  private cleanText(s: string): string {
    return s.replace(/<[^>]+>/g, "").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();
  }

  private gdeltKeywordIndex = 0;

  private async fetchGdelt(keywords: string[]): Promise<NewsItem[]> {
    if (keywords.length === 0) return [];

    // GDELT rate-limits to 1 req per 5s. We rotate through one keyword per
    // tick (poll = 120s by default), so each keyword fires every N*120s.
    // OR-queries with multi-word phrases are flaky — single phrase is safest.
    const kw = keywords[this.gdeltKeywordIndex % keywords.length];
    this.gdeltKeywordIndex++;

    const query = encodeURIComponent(`"${kw}"`);
    const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${query}&mode=ArtList&format=json&maxrecords=25&sort=DateDesc&timespan=24H`;

    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) {
        logger.debug({ kw, status: res.status }, "GDELT non-200");
        return [];
      }
      const text = await res.text();

      // GDELT returns plain text when rate-limited or query rejected
      if (!text.trim().startsWith("{")) {
        logger.warn({ kw, snippet: text.slice(0, 120) }, "GDELT returned non-JSON");
        return [];
      }

      let data: any;
      try { data = JSON.parse(text); } catch { return []; }
      const articles: any[] = data.articles ?? [];
      const items = articles.slice(0, 25).map((a) => ({
        title: a.title ?? "",
        source: a.domain ?? "gdelt",
        publishedAt: this.parseGdeltDate(a.seendate),
        url: a.url,
      })).filter((i) => i.title);

      logger.debug({ kw, count: items.length }, "GDELT ok");
      return items;
    } catch (e: any) {
      logger.debug({ kw, err: e?.message }, "GDELT fetch failed");
      return [];
    }
  }

  private parseGdeltDate(s: string | undefined): number {
    if (!s) return Date.now();
    // Format: 20260504T120000Z
    const m = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
    if (!m) return Date.now();
    const [, y, mo, d, hh, mm, ss] = m;
    return Date.UTC(+y!, +mo! - 1, +d!, +hh!, +mm!, +ss!);
  }

  private async fetchCryptoPanic(): Promise<NewsItem[]> {
    const token = process.env["CRYPTOPANIC_TOKEN"];
    if (!token) return []; // Silent skip — RSS sources cover us
    try {
      const url = `https://cryptopanic.com/api/developer/v2/posts/?auth_token=${token}&currencies=${this.symbol.toUpperCase()}&public=true`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return [];
      const data = await res.json() as any;
      const results: any[] = data.results ?? [];
      return results.slice(0, 25).map((r) => ({
        title: r.title ?? "",
        source: r.source?.domain ?? "cryptopanic",
        publishedAt: r.published_at ? Date.parse(r.published_at) : Date.now(),
        url: r.url,
      })).filter((i) => i.title);
    } catch {
      return [];
    }
  }

  // ── Helpers ───────────────────────────────────────────────

  private filterBySymbol(items: NewsItem[], symbol: string): NewsItem[] {
    const needles = [symbol.toLowerCase(), this.symbolToName(symbol)];
    return items.filter((i) => {
      const t = i.title.toLowerCase();
      return needles.some((n) => n && t.includes(n));
    });
  }

  private symbolToName(symbol: string): string {
    const map: Record<string, string> = { sol: "solana", btc: "bitcoin", eth: "ethereum" };
    return map[symbol.toLowerCase()] ?? "";
  }

  private filterFresh(items: NewsItem[], maxAgeMin: number): NewsItem[] {
    const cutoff = Date.now() - maxAgeMin * 60_000;
    return items.filter((i) => i.publishedAt >= cutoff);
  }
}
