import { Connection } from "@solana/web3.js";
import { OnChainHeuristics, S1Result } from "./s1_onchain_heuristics";
import { HoneypotDetector, S2Result } from "./s2_honeypot_detector";
import { IsolationForest, S3Result } from "./s3_isolation_forest";
import { AnomalyDetection, S4Result } from "./s4_anomaly_detection";
import { TokenScoreCache } from "../../cache/token_score_cache";
import { CacheManager } from "../../cache/cache_manager";
import { logger } from "../../utils/logger";

export interface SafetyResult {
  token: string;
  passed: boolean;
  failedAt?: string;
  s1: S1Result;
  s2?: S2Result;
  s3?: S3Result;
  s4?: S4Result;
}

export class SafetyPipeline {
  private s1: OnChainHeuristics;
  private s2: HoneypotDetector;
  private s3: IsolationForest;
  private s4: AnomalyDetection;

  constructor(connection: Connection, cache: CacheManager) {
    const tokenScoreCache = new TokenScoreCache(cache);
    this.s1 = new OnChainHeuristics(connection);
    this.s2 = new HoneypotDetector(connection);
    this.s3 = new IsolationForest(tokenScoreCache);
    this.s4 = new AnomalyDetection(connection);
  }

  async check(mintAddress: string, poolAddress?: string): Promise<SafetyResult> {
    logger.info({ token: mintAddress.slice(0, 8) + "..." }, "Running safety pipeline");

    // S1: On-chain heuristics
    const s1Result = await this.s1.check(mintAddress);
    if (!s1Result.passed) {
      logger.warn({ token: mintAddress.slice(0, 8) + "..." }, "REJECTED at S1");
      return { token: mintAddress, passed: false, failedAt: "S1", s1: s1Result };
    }

    // S2: Honeypot detection
    const s2Result = await this.s2.check(mintAddress, poolAddress);
    if (!s2Result.passed) {
      logger.warn({ token: mintAddress.slice(0, 8) + "..." }, "REJECTED at S2");
      return { token: mintAddress, passed: false, failedAt: "S2", s1: s1Result, s2: s2Result };
    }

    // S3: Isolation forest
    const s3Result = await this.s3.check(mintAddress);
    if (!s3Result.passed) {
      logger.warn({ token: mintAddress.slice(0, 8) + "..." }, "REJECTED at S3");
      return { token: mintAddress, passed: false, failedAt: "S3", s1: s1Result, s2: s2Result, s3: s3Result };
    }

    // S4: Anomaly detection
    const s4Result = await this.s4.check(mintAddress);
    if (!s4Result.passed) {
      logger.warn({ token: mintAddress.slice(0, 8) + "..." }, "REJECTED at S4");
      return { token: mintAddress, passed: false, failedAt: "S4", s1: s1Result, s2: s2Result, s3: s3Result, s4: s4Result };
    }

    logger.info({ token: mintAddress.slice(0, 8) + "..." }, "ALL SAFETY CHECKS PASSED");
    return { token: mintAddress, passed: true, s1: s1Result, s2: s2Result, s3: s3Result, s4: s4Result };
  }
}