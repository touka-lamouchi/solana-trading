import type { EngineDeps } from "../../deps";
import type { GraphStateType } from "../../state";
import { logger } from "../../../utils/logger";

// Ingests the current pool states into the feature window maintained by
// IngestionService (Binance candles + Pyth ticks). Called before ai_decision
// so the LSTM/GRU models see up-to-date market state.
export function makeIngestCandles(deps: EngineDeps) {
  return async (state: GraphStateType): Promise<Partial<GraphStateType>> => {
    logger.debug({ node: "ingest_candles" }, "graph: ingest_candles");

    const mintForPool = (key: string): string => {
      const pool = deps.pools[key];
      if (!pool) return "";
      // Prefer the non-USDC side so the feature window tracks the volatile leg.
      const mintB: string = deps.tokens.tokenB?.mint ?? "";
      const mintA: string = deps.tokens.tokenA?.mint ?? "";
      if (mintB && mintB !== deps.baseMint) return mintB;
      if (mintA && mintA !== deps.baseMint) return mintA;
      return "";
    };

    try {
      await deps.ingestionService.ingestPoolStates(
        state.poolStates as any,
        mintForPool,
      );
    } catch (e: any) {
      logger.warn({ error: e.message }, "ingest_candles: ingestion failed (non-fatal)");
    }

    return {};
  };
}
