import type { EngineDeps } from "../../deps";
import type { GraphStateType } from "../../state";
import { ValidPool } from "../../state";
import { logger } from "../../../utils/logger";

// Reads all pool states — from PoolMonitor cache (zero RPC calls) when running,
// or falls back to RPC via arbDetector.getPoolState(). Populates poolStates,
// validPools, and poolsScanned for downstream nodes.
export function makeScanPools(deps: EngineDeps) {
  return async (_state: GraphStateType): Promise<Partial<GraphStateType>> => {
    logger.debug({ node: "scan_pools" }, "graph: scan_pools");

    const poolEntries = Object.entries(deps.pools) as [string, any][];
    const poolStates = new Map<string, import("../../../layer1_opportunity/pure_code/arbitrage_detector").PoolState>();
    const validPools: ValidPool[] = [];

    if (deps.poolMonitor?.isRunning()) {
      for (const [key] of poolEntries) {
        const s = deps.poolMonitor.getState(key);
        if (s) {
          poolStates.set(key, s);
          validPools.push({ key, pool: deps.pools[key], state: s });
        }
      }
    } else {
      for (const [key, pool] of poolEntries) {
        try {
          const s = await deps.arbDetector.getPoolState(pool);
          poolStates.set(key, s);
          validPools.push({ key, pool, state: s });
        } catch (e: any) {
          logger.warn({ pool: key, error: e.message }, "scan_pools: pool read failed");
        }
      }
    }

    logger.debug({ poolsScanned: validPools.length }, "scan_pools done");
    return { poolStates, validPools, poolsScanned: validPools.length };
  };
}
