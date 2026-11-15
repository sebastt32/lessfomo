import { Module } from "@nestjs/common";
import { LiveFeed } from "./application/live-feed.js";

/** Injection token of the single in-memory `LiveFeed`. */
export const LIVE_FEED = Symbol("LIVE_FEED");

@Module({
  providers: [{ provide: LIVE_FEED, useFactory: () => new LiveFeed() }],
  exports: [LIVE_FEED],
})
export class LiveFeedModule {}
