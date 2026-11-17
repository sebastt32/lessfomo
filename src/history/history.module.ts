import { Inject, Injectable, Module, type OnApplicationShutdown } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/app-config.js";
import { errorMessage } from "../shared/error-message.js";
import type { HistoryReader } from "./domain/history-reader.js";
import type { HistoryRecorder } from "./domain/history-recorder.js";
import type { TokenCatalogReader } from "./domain/token-catalog-reader.js";
import type { SnapshotStore } from "../snapshots/domain/snapshot-store.js";
import type { WalletReputationStore } from "../wallet-reputation/domain/wallet-reputation-store.js";
import { openHistoryStore, type HistoryStore } from "./infrastructure/open-history-store.js";

/** Injection token of the opened `HistoryStore`. */
export const HISTORY_STORE = Symbol("HISTORY_STORE");
/** Injection token of the `HistoryReader` port. */
export const HISTORY_READER = Symbol("HISTORY_READER");
/** Injection token of the `HistoryRecorder` port. */
export const HISTORY_RECORDER = Symbol("HISTORY_RECORDER");
/** Injection token of the `TokenCatalogReader` port (token list, snapshots, stats). */
export const TOKEN_CATALOG_READER = Symbol("TOKEN_CATALOG_READER");
/** Injection token of the `SnapshotStore` port. */
export const SNAPSHOT_STORE = Symbol("SNAPSHOT_STORE");
/** Injection token of the `WalletReputationStore` port (wallet results, reputations, smart wallets). */
export const WALLET_REPUTATION_STORE = Symbol("WALLET_REPUTATION_STORE");

/** Closes the store last, after the API stopped serving it. */
@Injectable()
export class HistoryLifecycle implements OnApplicationShutdown {
  constructor(@Inject(HISTORY_STORE) private readonly store: HistoryStore) {}

  async onApplicationShutdown(): Promise<void> {
    await this.store.history.close().catch((error: unknown) => console.error(`[history] ${errorMessage(error)}`));
  }
}

@Module({
  providers: [
    {
      provide: HISTORY_STORE,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): Promise<HistoryStore> => openHistoryStore(config.history),
    },
    { provide: HISTORY_READER, inject: [HISTORY_STORE], useFactory: (store: HistoryStore): HistoryReader => store.history },
    {
      provide: HISTORY_RECORDER,
      inject: [HISTORY_STORE],
      useFactory: (store: HistoryStore): HistoryRecorder => store.history,
    },
    {
      provide: TOKEN_CATALOG_READER,
      inject: [HISTORY_STORE],
      useFactory: (store: HistoryStore): TokenCatalogReader => store.history,
    },
    { provide: SNAPSHOT_STORE, inject: [HISTORY_STORE], useFactory: (store: HistoryStore): SnapshotStore => store.history },
    {
      provide: WALLET_REPUTATION_STORE,
      inject: [HISTORY_STORE],
      useFactory: (store: HistoryStore): WalletReputationStore => store.history,
    },
    HistoryLifecycle,
  ],
  exports: [HISTORY_STORE, HISTORY_READER, HISTORY_RECORDER, TOKEN_CATALOG_READER, SNAPSHOT_STORE, WALLET_REPUTATION_STORE],
})
export class HistoryModule {}
