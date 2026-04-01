import http from "http";

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
}