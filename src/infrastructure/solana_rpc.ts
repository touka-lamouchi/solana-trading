import { Connection } from "@solana/web3.js";
import { logger } from "../utils/logger";

export class SolanaRPC {
  private connection: Connection;

  constructor() {
    this.connection = new Connection(
      "https://api.devnet.solana.com",
      {
        wsEndpoint: "wss://api.devnet.solana.com/",
        commitment: "confirmed",
      }
    );
  }

  getConnection(): Connection {
    return this.connection;
  }

  async subscribeToSlots(): Promise<void> {
    this.connection.onSlotChange((slotInfo) => {
      logger.info({
        slot: slotInfo.slot,
        parent: slotInfo.parent,
        root: slotInfo.root,
      }, "New slot");
    });
    logger.info("Subscribed to slot changes on devnet");
  }

  async getLatestBlockhash(): Promise<string> {
    const { blockhash } = await this.connection.getLatestBlockhash();
    return blockhash;
  }
}