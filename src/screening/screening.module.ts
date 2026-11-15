import { Module } from "@nestjs/common";
import { HistoryModule } from "../history/history.module.js";
import { LiveFeedModule } from "../live-feed/live-feed.module.js";
import { MarketPriceModule } from "../market-price/market-price.module.js";
import { MomentumModule } from "../momentum/momentum.module.js";
import { SafetyChecksModule } from "../safety-checks/safety-checks.module.js";
import { TokenDiscoveryModule } from "../token-discovery/token-discovery.module.js";
import { ScreeningPipeline } from "./screening-pipeline.js";

@Module({
  imports: [TokenDiscoveryModule, SafetyChecksModule, MomentumModule, HistoryModule, LiveFeedModule, MarketPriceModule],
  providers: [ScreeningPipeline],
  exports: [ScreeningPipeline],
})
export class ScreeningModule {}
