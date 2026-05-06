import { Connection } from "@solana/web3.js";
import { getConfig } from "../utils/config";
import { logger } from "../utils/logger";

export class MainnetRPC {
  private connection: Connection;

  constructor(rpcUrl?: string) {
    const cfg = getConfig();
    const url = rpcUrl ?? cfg.network?.mainnet_rpc_url ?? "https://api.mainnet-beta.solana.com";
    this.connection = new Connection(url, { commitment: "confirmed" });
    logger.info({ url }, "Mainnet data RPC initialized (read-only)");
  }

  getConnection(): Connection {
    return this.connection;
  }
}
