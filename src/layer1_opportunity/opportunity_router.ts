import { ArbOpportunity } from "./pure_code/arbitrage_detector";
import { LiquidationOpportunity } from "./pure_code/liquidation_hunter";
import { YieldOpportunity } from "./pure_code/yield_rate_monitor";
import { logger } from "../utils/logger";

export type Opportunity = ArbOpportunity | LiquidationOpportunity | YieldOpportunity;

export type PathType = "fast" | "slow" | "liq";

export interface RoutedOpportunity {
  opportunity: Opportunity;
  path: PathType;
  reason: string;
}

export class OpportunityRouter {
  route(opportunity: Opportunity): RoutedOpportunity {
    let path: PathType;
    let reason: string;

    switch (opportunity.type) {
      case "arbitrage":
        path = "fast";
        reason = "Arbitrage — atomic flash loan, no capital risk";
        break;
      case "liquidation":
        path = "liq";
        reason = "Liquidation — calls programs-lending liquidate instruction";
        break;
      case "yield":
        path = "slow";
        reason = "Yield farming — requires own capital, AI confirmed";
        break;
      case "directional":
        path = "slow";
        reason = "AI-predicted price movement — single-hop swap with own capital";
        break;
      default:
        path = "slow";
        reason = "Unknown type — defaulting to slow path for safety";
    }

    logger.info({
      type: opportunity.type,
      path,
      reason,
    }, "Opportunity routed");

    return { opportunity, path, reason };
  }
}