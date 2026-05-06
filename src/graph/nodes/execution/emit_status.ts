import type { EngineDeps } from "../../deps";
import type { GraphStateType } from "../../state";

// Broadcasts the scan_complete WS event after build_summary assembles the
// TickResult. Merges polling-loop result counts with event-driven reactor
// counts so the frontend stream is unified. No-ops when wsEmit is absent
// (tests, single-user mode).
export function makeEmitStatus(deps: EngineDeps) {
  return async (state: GraphStateType): Promise<Partial<GraphStateType>> => {
    if (!deps.wsEmit) return {};

    const reactor = deps.engine.consumeReactorCounters();
    deps.wsEmit({
      type: "scan_complete",
      poolsScanned: state.result?.poolsScanned ?? 0,
      opportunitiesFound: (state.result?.opportunitiesFound ?? 0) + reactor.opportunities,
      poolEvents: reactor.poolEvents,
      timestamp: Date.now(),
    });

    return {};
  };
}
