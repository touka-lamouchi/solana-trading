import { Connection } from "@solana/web3.js";
import { ArbitrageDetector } from "../../src/layer1_opportunity/pure_code/arbitrage_detector";
import { LiquidationHunter } from "../../src/layer1_opportunity/pure_code/liquidation_hunter";
import { YieldRateMonitor } from "../../src/layer1_opportunity/pure_code/yield_rate_monitor";
import { OpportunityRouter } from "../../src/layer1_opportunity/opportunity_router";
import { logger } from "../../src/utils/logger";
import fs from "fs";

async function testDetectors() {
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const pools = JSON.parse(fs.readFileSync("config/devnet_pools.json", "utf-8"));

  logger.info("=== Testing Arbitrage Detector ===");

  const arbDetector = new ArbitrageDetector(connection, 0.1); // 0.1% min profit
  const arbOpps = await arbDetector.scan(pools);

  logger.info({ found: arbOpps.length }, "Arbitrage scan complete");

  logger.info("=== Testing Liquidation Hunter ===");

  const liqHunter = new LiquidationHunter(0.5);

  // Simulate some loan positions
  liqHunter.loadSimulatedPositions([
    {
      borrower: "borrower_1",
      collateralToken: "fSOL",
      debtToken: "fUSDC",
      collateralAmount: 10,
      debtAmount: 900,
      collateralPrice: 100,  // 10 * 100 = 1000 collateral
      debtPrice: 1,          // 900 debt → health = 1.11
      liquidationThreshold: 1.2,  // under 1.2 = liquidatable
    },
    {
      borrower: "borrower_2",
      collateralToken: "fSOL",
      debtToken: "fUSDC",
      collateralAmount: 5,
      debtAmount: 600,
      collateralPrice: 100,  // 5 * 100 = 500 collateral
      debtPrice: 1,          // 600 debt → health = 0.83
      liquidationThreshold: 1.2,  // LIQUIDATABLE
    },
    {
      borrower: "borrower_3",
      collateralToken: "fRAY",
      debtToken: "fUSDC",
      collateralAmount: 10000,
      debtAmount: 2500,
      collateralPrice: 0.20, // 10000 * 0.20 = 2000 collateral
      debtPrice: 1,          // 2500 debt → health = 0.80
      liquidationThreshold: 1.2,  // LIQUIDATABLE
    },
  ]);

  const liqOpps = liqHunter.scan();
  logger.info({ found: liqOpps.length }, "Liquidation scan complete");

  logger.info("=== Testing Yield Rate Monitor ===");

  const yieldMonitor = new YieldRateMonitor(2.0);

  yieldMonitor.loadSimulatedYields([
    { protocol: "Protocol A", token: "fUSDC", apy: 5.2, tvl: 1000000, lastUpdated: Date.now() },
    { protocol: "Protocol B", token: "fUSDC", apy: 12.8, tvl: 500000, lastUpdated: Date.now() },
    { protocol: "Protocol A", token: "fSOL", apy: 8.1, tvl: 2000000, lastUpdated: Date.now() },
    { protocol: "Protocol B", token: "fSOL", apy: 8.5, tvl: 1500000, lastUpdated: Date.now() },
    { protocol: "Protocol C", token: "fSOL", apy: 15.3, tvl: 300000, lastUpdated: Date.now() },
  ]);

  const yieldOpps = yieldMonitor.scan();
  logger.info({ found: yieldOpps.length }, "Yield scan complete");

  logger.info("=== Testing Opportunity Router ===");

  const router = new OpportunityRouter();

  // Route each opportunity found
  for (const arb of arbOpps) {
    router.route(arb);
  }
  for (const liq of liqOpps) {
    router.route(liq);
  }
  for (const y of yieldOpps) {
    router.route(y);
  }

  logger.info("=== All detectors tested ===");
}

testDetectors().catch(console.error);