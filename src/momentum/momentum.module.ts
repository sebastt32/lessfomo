import { Module } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/app-config.js";
import { LiveFeedModule, LIVE_FEED } from "../live-feed/live-feed.module.js";
import type { LiveFeed } from "../live-feed/application/live-feed.js";
import { MomentumTracker } from "./application/momentum-tracker.js";
import type { TradeSource } from "./domain/trade-source.js";
import { SolanaLogsTradeSource } from "./infrastructure/solana-logs/solana-logs-trade-source.js";

/** Injection token of the `MomentumTracker`. */
export const MOMENTUM_TRACKER = Symbol("MOMENTUM_TRACKER");
/** Injection token of the `TradeSource` port (Solana RPC logs). */
export const TRADE_SOURCE = Symbol("TRADE_SOURCE");

@Module({
  imports: [LiveFeedModule],
  providers: [
    {
      provide: MOMENTUM_TRACKER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => new MomentumTracker({ trackingWindowMs: config.momentum.trackingWindowMs }),
    },
    {
      provide: TRADE_SOURCE,
      inject: [APP_CONFIG, LIVE_FEED],
      useFactory: (config: AppConfig, feed: LiveFeed): TradeSource =>
        new SolanaLogsTradeSource({
          ...(config.solana.wsUrl !== undefined && { url: config.solana.wsUrl }),
          onStatus: (status) => {
            console.log(`[solana-logs] ${status}`);
            feed.sourceStatusFromSocket("solanaLogs", status);
          },
        }),
    },
  ],
  exports: [MOMENTUM_TRACKER, TRADE_SOURCE],
})
export class MomentumModule {}
