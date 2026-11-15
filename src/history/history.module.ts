import { Inject, Injectable, Module, type OnApplicationShutdown } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/app-config.js";
import { errorMessage } from "../shared/error-message.js";
import type { HistoryReader } from "./domain/history-reader.js";
import type { HistoryRecorder } from "./domain/history-recorder.js";
import { openHistoryStore, type HistoryStore } from "./infrastructure/open-history-store.js";

/** Injection token of the opened `HistoryStore`. */
export const HISTORY_STORE = Symbol("HISTORY_STORE");
/** Injection token of the `HistoryReader` port. */
export const HISTORY_READER = Symbol("HISTORY_READER");
/** Injection token of the `HistoryRecorder` port. */
export const HISTORY_RECORDER = Symbol("HISTORY_RECORDER");

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
    HistoryLifecycle,
  ],
  exports: [HISTORY_STORE, HISTORY_READER, HISTORY_RECORDER],
})
export class HistoryModule {}
