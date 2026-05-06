import http from "http";

export interface RegimeResult {
  regime: "trending" | "ranging" | "crash";
  confidence: number;
  mock: boolean;
}

export interface DirectionResult {
  direction: "up" | "down" | "neutral";
  confidence: number;
  predicted_change: number;
  mock: boolean;
}

export interface SentimentResult {
  score: number;       // -1 to +1
  label: string;       // positive | negative | neutral
  volume: number;
  mock: boolean;
}

export interface VolExpansionResult {
  expansion_prob: number;  // 0-1
  mock: boolean;
}

export interface FeaturesResult {
  regime_features: string[];
  gru_features: string[];
  gru_sequence_length: number;
}

export class ModelServer {
  private baseUrl: string;

  constructor(host: string = "localhost", port: number = 8000) {
    this.baseUrl = `http://${host}:${port}`;
  }

  async healthCheck(): Promise<boolean> {
    return new Promise((resolve) => {
      http
        .get(`${this.baseUrl}/health`, (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            try {
              const parsed = JSON.parse(data);
              resolve(parsed.status === "ok");
            } catch {
              resolve(false);
            }
          });
        })
        .on("error", () => resolve(false));
    });
  }

  private async get<T>(path: string): Promise<T | null> {
    return new Promise((resolve) => {
      const url = new URL(path, this.baseUrl);
      const req = http.get(
        { hostname: url.hostname, port: url.port, path: url.pathname, timeout: 10000 },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            try { resolve(JSON.parse(data) as T); } catch { resolve(null); }
          });
        },
      );
      req.on("error", () => resolve(null));
      req.on("timeout", () => { req.destroy(); resolve(null); });
    });
  }

  async getFeatures(): Promise<FeaturesResult | null> {
    return this.get<FeaturesResult>("/features");
  }

  private async post<T>(path: string, body: object): Promise<T | null> {
    return new Promise((resolve) => {
      const payload = JSON.stringify(body);
      const url = new URL(path, this.baseUrl);

      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
          },
          timeout: 15000,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            try {
              resolve(JSON.parse(data) as T);
            } catch {
              resolve(null);
            }
          });
        },
      );

      req.on("error", () => resolve(null));
      req.on("timeout", () => {
        req.destroy();
        resolve(null);
      });
      req.write(payload);
      req.end();
    });
  }

  async predictRegime(token: string, features?: number[]): Promise<RegimeResult | null> {
    return this.post<RegimeResult>("/predict/regime", { token, features });
  }

  async predictDirection(token: string, features?: number[]): Promise<DirectionResult | null> {
    return this.post<DirectionResult>("/predict/direction", { token, features });
  }

  async predictSentiment(token: string): Promise<SentimentResult | null> {
    return this.post<SentimentResult>("/predict/sentiment", { token });
  }

  async predictVolExpansion(token: string, features: number[]): Promise<VolExpansionResult | null> {
    return this.post<VolExpansionResult>("/predict/vol-expansion", { token, features });
  }

  async predictNewsSentiment(
    headlines: string[],
    context: "crypto" | "geopolitics" = "crypto",
  ): Promise<NewsSentimentResult | null> {
    return this.post<NewsSentimentResult>("/predict/news-sentiment", { headlines, context });
  }
}

export interface NewsSentimentResult {
  score: number;       // -1..+1
  magnitude: number;   // 0..1
  count: number;
  mock: boolean;
}
