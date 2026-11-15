import { Module } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/app-config.js";
import { HistoryModule, SNAPSHOT_STORE } from "../history/history.module.js";
import type { HolderDistributionReader } from "../safety-checks/domain/holder-distribution-reader.js";
import { HOLDER_DISTRIBUTION_READER, SafetyChecksModule } from "../safety-checks/safety-checks.module.js";
import { errorMessage } from "../shared/error-message.js";
import { HolderSnapshots } from "./application/holder-snapshots.js";
import { SnapshotScheduler } from "./application/snapshot-scheduler.js";
import type { MarketDataSource } from "./domain/market-data-source.js";
import type { SnapshotStore } from "./domain/snapshot-store.js";
import { DexScreenerMarketData } from "./infrastructure/dexscreener/dexscreener-market-data.js";

/** Injection token of the `SnapshotScheduler`. */
export const SNAPSHOT_SCHEDULER = Symbol("SNAPSHOT_SCHEDULER");
/** Injection token of the `MarketDataSource` port (DexScreener). */
export const MARKET_DATA_SOURCE = Symbol("MARKET_DATA_SOURCE");

const report = (error: unknown): void => console.error(`[snapshots] ${errorMessage(error)}`);

@Module({
  imports: [HistoryModule, SafetyChecksModule],
  providers: [
    {
      provide: MARKET_DATA_SOURCE,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): MarketDataSource =>
        new DexScreenerMarketData({ minIntervalMs: config.snapshots.dexMinIntervalMs, onError: report }),
    },
    {
      provide: SNAPSHOT_SCHEDULER,
      inject: [APP_CONFIG, SNAPSHOT_STORE, MARKET_DATA_SOURCE, HOLDER_DISTRIBUTION_READER],
      useFactory: (
        config: AppConfig,
        store: SnapshotStore,
        marketData: MarketDataSource,
        reader: HolderDistributionReader,
      ): SnapshotScheduler =>
        new SnapshotScheduler({
          store,
          marketData,
          holders: new HolderSnapshots({
            store,
            reader,
            minIntervalMs: config.snapshots.holderMinIntervalMs,
            onError: report,
          }),
          trackingWindowMs: config.momentum.trackingWindowMs,
          tickIntervalMs: config.snapshots.tickIntervalMs,
          onError: report,
        }),
    },
  ],
  exports: [SNAPSHOT_SCHEDULER, MARKET_DATA_SOURCE],
})
export class SnapshotsModule {}
