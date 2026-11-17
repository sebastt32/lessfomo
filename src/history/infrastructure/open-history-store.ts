import type { SnapshotStore } from "../../snapshots/domain/snapshot-store.js";
import type { HistoryReader } from "../domain/history-reader.js";
import type { HistoryRecorder } from "../domain/history-recorder.js";
import type { TokenCatalogReader } from "../domain/token-catalog-reader.js";
import { errorMessage } from "../../shared/error-message.js";
import type { WalletReputationStore } from "../../wallet-reputation/domain/wallet-reputation-store.js";
import type { SessionStore } from "../../auth/domain/session-store.js";
import type { UserStore } from "../../auth/domain/user-store.js";
import { PostgresHistory } from "./postgres/postgres-history.js";
import { SqliteHistoryRecorder } from "./sqlite/sqlite-history-recorder.js";

export interface History
  extends HistoryRecorder, HistoryReader, SnapshotStore, TokenCatalogReader, WalletReputationStore, UserStore, SessionStore {
  close(): Promise<void>;
}

/** The open history and a log-safe description of where it lives. */
export interface HistoryStore {
  readonly history: History;
  readonly description: string;
}

export interface HistoryLocation {
  readonly databaseUrl: string | undefined;
  readonly sqlitePath: string;
}

/** The history store could not be opened; the process cannot record anything without it. */
export class HistoryStoreUnavailableError extends Error {
  constructor(cause: unknown) {
    super(errorMessage(cause), { cause });
    this.name = "HistoryStoreUnavailableError";
  }
}

/** PostgreSQL when a database URL is set, otherwise a local SQLite file. Never logs the connection string. */
export const openHistoryStore = async ({ databaseUrl, sqlitePath }: HistoryLocation): Promise<HistoryStore> => {
  try {
    if (databaseUrl) {
      const history = await PostgresHistory.connect(databaseUrl, {
        onError: (error) => console.error(`[history] ${errorMessage(error)}`),
      });
      return { history, description: "PostgreSQL (DATABASE_URL)" };
    }
    return { history: new SqliteHistoryRecorder(sqlitePath), description: `SQLite (${sqlitePath})` };
  } catch (error) {
    throw new HistoryStoreUnavailableError(error);
  }
};
