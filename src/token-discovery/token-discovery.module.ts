import { Module } from "@nestjs/common";
import { LiveFeedModule, LIVE_FEED } from "../live-feed/live-feed.module.js";
import type { LiveFeed } from "../live-feed/application/live-feed.js";
import type { NewTokenSource } from "./domain/new-token-source.js";
import { PumpPortalNewTokenSource } from "./infrastructure/pumpportal/pumpportal-new-token-source.js";

/** Injection token of the `NewTokenSource` port (PumpPortal). */
export const NEW_TOKEN_SOURCE = Symbol("NEW_TOKEN_SOURCE");

@Module({
  imports: [LiveFeedModule],
  providers: [
    {
      provide: NEW_TOKEN_SOURCE,
      inject: [LIVE_FEED],
      useFactory: (feed: LiveFeed): NewTokenSource =>
        new PumpPortalNewTokenSource({
          onStatus: (status) => {
            console.log(`[pumpportal] ${status}`);
            feed.sourceStatusFromSocket("pumpportal", status);
          },
        }),
    },
  ],
  exports: [NEW_TOKEN_SOURCE],
})
export class TokenDiscoveryModule {}
