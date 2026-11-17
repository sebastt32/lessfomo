import { Module } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/app-config.js";
import { HistoryModule, TOKEN_CYCLE_STORE, WALLET_REPUTATION_STORE } from "../history/history.module.js";
import type { LiveFeed } from "../live-feed/application/live-feed.js";
import { LIVE_FEED, LiveFeedModule } from "../live-feed/live-feed.module.js";
import { errorMessage } from "../shared/error-message.js";
import type { SmartWalletTracker } from "../wallet-reputation/application/smart-wallet-tracker.js";
import type { WalletReputationStore } from "../wallet-reputation/domain/wallet-reputation-store.js";
import { SMART_WALLET_TRACKER, WalletReputationModule } from "../wallet-reputation/wallet-reputation.module.js";
import { ExtendedTradeStorage } from "./application/extended-trade-storage.js";
import { TokenCycleQueries } from "./application/token-cycle-queries.js";
import { TokenCycleTracker } from "./application/token-cycle-tracker.js";
import type { TokenCycleStore } from "./domain/token-cycle-store.js";

/** Injection token of the `TokenCycleTracker` (cycles of public tokens, live and backfill). */
export const TOKEN_CYCLE_TRACKER = Symbol("TOKEN_CYCLE_TRACKER");
/** Injection token of the `ExtendedTradeStorage` (public tokens stored trade by trade after their momentum window). */
export const EXTENDED_TRADE_STORAGE = Symbol("EXTENDED_TRADE_STORAGE");
/** Injection token of the `TokenCycleQueries` read by the API. */
export const TOKEN_CYCLE_QUERIES = Symbol("TOKEN_CYCLE_QUERIES");

const report = (error: unknown): void => console.error(`[cycles] ${errorMessage(error)}`);

@Module({
  imports: [HistoryModule, LiveFeedModule, WalletReputationModule],
  providers: [
    {
      provide: EXTENDED_TRADE_STORAGE,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): ExtendedTradeStorage => new ExtendedTradeStorage({ maxTokens: config.tokenCycle.maxExtendedTokens }),
    },
    {
      provide: TOKEN_CYCLE_TRACKER,
      inject: [APP_CONFIG, TOKEN_CYCLE_STORE, WALLET_REPUTATION_STORE, LIVE_FEED, SMART_WALLET_TRACKER, EXTENDED_TRADE_STORAGE],
      useFactory: (
        config: AppConfig,
        store: TokenCycleStore,
        reputation: WalletReputationStore,
        feed: LiveFeed,
        smartWallets: SmartWalletTracker,
        extended: ExtendedTradeStorage,
      ): TokenCycleTracker => {
        const minimum = config.api.publicMinConvictionWallets;
        return new TokenCycleTracker({
          store,
          rules: config.tokenCycle.rules,
          extended,
          publicMinConvictionWallets: minimum,
          publicTrackingMs: config.tokenCycle.publicTrackingMs,
          trackingWindowMs: config.momentum.trackingWindowMs,
          convictionFirstBuys: (mint) => smartWallets.convictionFirstBuys(mint),
          // The public visibility rule: live count while the token is followed, else the stored one.
          isPublic: async (mint) => feed.isPublic(mint) || (await reputation.tokenSmartSummary(mint)).conviction >= minimum,
          onCycle: (mint, cycle) => feed.cycleUpdated(mint, cycle),
          onEvent: (mint, cycle) => feed.cycleChanged(mint, cycle),
          eventMinIntervalMs: config.tokenCycle.eventMinIntervalMs,
          backfillBatchSize: config.tokenCycle.backfillBatchSize,
          startDelayMs: config.tokenCycle.startDelayMs,
          log: (line) => console.log(line),
          onError: report,
        });
      },
    },
    {
      provide: TOKEN_CYCLE_QUERIES,
      inject: [TOKEN_CYCLE_STORE],
      useFactory: (store: TokenCycleStore): TokenCycleQueries => new TokenCycleQueries(store),
    },
  ],
  exports: [TOKEN_CYCLE_TRACKER, EXTENDED_TRADE_STORAGE, TOKEN_CYCLE_QUERIES],
})
export class TokenCycleModule {}
