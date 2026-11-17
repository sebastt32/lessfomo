import { Module } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/app-config.js";
import { LiveFeed } from "./application/live-feed.js";

/** Injection token of the single in-memory `LiveFeed`. */
export const LIVE_FEED = Symbol("LIVE_FEED");

@Module({
  providers: [
    {
      provide: LIVE_FEED,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => new LiveFeed(config.api.publicMinSmartWallets),
    },
  ],
  exports: [LIVE_FEED],
})
export class LiveFeedModule {}
