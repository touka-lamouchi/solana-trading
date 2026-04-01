import { logger } from "../utils/logger";

// Stub — will connect to Pyth/Chainlink devnet in Phase 10 (RWA)
export class OracleFeeds {
  async start(): Promise<void> {
    logger.info("Oracle feeds: stub ready (connects in Phase 10)");
  }
}