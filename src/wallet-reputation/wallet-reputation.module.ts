import { Module } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/app-config.js";
import { HistoryModule, WALLET_REPUTATION_STORE } from "../history/history.module.js";
import type { LiveFeed } from "../live-feed/application/live-feed.js";
import { LIVE_FEED, LiveFeedModule } from "../live-feed/live-feed.module.js";
import { errorMessage } from "../shared/error-message.js";
import { ReputationCloser } from "./application/reputation-closer.js";
import { SmartWalletTracker } from "./application/smart-wallet-tracker.js";
import { WalletReputationQueries } from "./application/wallet-reputation-queries.js";
import type { WalletReputationStore } from "./domain/wallet-reputation-store.js";

/** Injection token of the live `SmartWalletTracker`. */
export const SMART_WALLET_TRACKER = Symbol("SMART_WALLET_TRACKER");
/** Injection token of the `ReputationCloser` (close job and backfill). */
export const REPUTATION_CLOSER = Symbol("REPUTATION_CLOSER");
/** Injection token of the `WalletReputationQueries` read by the API. */
export const WALLET_REPUTATION_QUERIES = Symbol("WALLET_REPUTATION_QUERIES");

const report = (error: unknown): void => console.error(`[reputation] ${errorMessage(error)}`);

@Module({
  imports: [HistoryModule, LiveFeedModule],
  providers: [
    {
      provide: SMART_WALLET_TRACKER,
      inject: [APP_CONFIG, LIVE_FEED, WALLET_REPUTATION_STORE],
      useFactory: (config: AppConfig, feed: LiveFeed, store: WalletReputationStore): SmartWalletTracker =>
        new SmartWalletTracker({
          trackingWindowMs: config.momentum.trackingWindowMs,
          rules: config.walletReputation.rules,
          statsAtBuys: (buys, excludedMint) => store.statsAtBuys(buys, config.walletReputation.rules.lookbackMs, excludedMint),
          onChange: (change) => feed.smartWalletChanged(change),
          persist: (mint, entry) => {
            try {
              store.saveSmartWallet(mint, entry).catch(report);
            } catch (error) {
              report(error);
            }
          },
        }),
    },
    {
      provide: REPUTATION_CLOSER,
      inject: [APP_CONFIG, WALLET_REPUTATION_STORE, SMART_WALLET_TRACKER],
      useFactory: (config: AppConfig, store: WalletReputationStore, tracker: SmartWalletTracker): ReputationCloser =>
        new ReputationCloser({
          store,
          rules: config.walletReputation.rules,
          trackingWindowMs: config.momentum.trackingWindowMs,
          closeGraceMs: config.walletReputation.closeGraceMs,
          batchSize: config.walletReputation.batchSize,
          startDelayMs: config.walletReputation.startDelayMs,
          onRecords: (records) => tracker.updateRecords(records),
          onClosedThrough: (completeThrough, closed) => tracker.rateThrough(completeThrough, closed),
          log: (line) => console.log(line),
          onError: report,
        }),
    },
    {
      provide: WALLET_REPUTATION_QUERIES,
      inject: [APP_CONFIG, WALLET_REPUTATION_STORE],
      useFactory: (config: AppConfig, store: WalletReputationStore) =>
        new WalletReputationQueries(store, config.walletReputation.rules),
    },
  ],
  exports: [SMART_WALLET_TRACKER, REPUTATION_CLOSER, WALLET_REPUTATION_QUERIES],
})
export class WalletReputationModule {}
