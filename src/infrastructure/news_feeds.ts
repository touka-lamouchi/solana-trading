import { logger } from "../utils/logger";

// Stub — will connect to Bloomberg, Reuters, Fed APIs in Phase 8
export class NewsFeeds {
  async start(): Promise<void> {
    logger.info("News feeds: stub ready (connects in Phase 8)");
  }
}