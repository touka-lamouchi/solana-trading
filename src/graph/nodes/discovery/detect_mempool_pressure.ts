import type { EngineDeps } from "../../deps";
import type { GraphStateType } from "../../state";
import { wrapSignalOpp, resolveSignalMint, borrowCap } from "../utils";
import { logger } from "../../../utils/logger";

// Mempool pressure detector — reads MempoolMonitor buy/sell flow on mainnet
// Raydium V4 + Orca Whirlpool. Reuses the shared MempoolSignal — no double
// subscription or duplicate cache reads.
export function makeDetectMempoolPressure(deps: EngineDeps) {
  return async (state: GraphStateType): Promise<Partial<GraphStateType>> => {
    logger.debug({ node: "detect_mempool_pressure" }, "graph: detect_mempool_pressure");

    const p1 = state.poolStates.get("pool1");
    if (!p1) return {};

    const signalMint = resolveSignalMint(deps.tokens);
    const tradeMint: string = deps.tokens.tokenB?.mint ?? "";
    const cap = Math.min(borrowCap(), 200);

    const mpOpp = await deps.mempoolPressureDetector.scan({
      tokenMint: signalMint,
      capital: cap,
      pool: p1,
      baseTokenName: "fUSDC",
      primaryTokenName: "fSOL",
    });

    if (!mpOpp) return {};

    logger.debug({ path: mpOpp.path }, "detect_mempool_pressure: found");
    return { opportunities: [wrapSignalOpp(mpOpp, p1, tradeMint)] };
  };
}
