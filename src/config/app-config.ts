/** Everything the process reads from its environment, read once at startup. */
export interface AppConfig {
  readonly startedAt: Date;
  readonly api: {
    readonly host: string;
    readonly port: number;
    /** Browser origins allowed by CORS. */
    readonly corsOrigins: readonly string[];
    /** Interval between `: ping` comments on open SSE streams. */
    readonly heartbeatMs: number;
  };
  readonly history: {
    /** PostgreSQL when set, otherwise SQLite at `sqlitePath`. */
    readonly databaseUrl: string | undefined;
    readonly sqlitePath: string;
  };
  readonly screening: {
    readonly evaluationDelayMs: number;
    readonly minIntervalMs: number;
    readonly maxPending: number;
  };
  readonly momentum: {
    readonly trackingWindowMs: number;
    readonly reportIntervalMs: number;
    readonly topMovers: number;
  };
  readonly solana: {
    readonly rpcUrl: string | undefined;
    readonly wsUrl: string | undefined;
  };
}

export type Environment = Readonly<Record<string, string | undefined>>;

/** Injection token of the `AppConfig`. */
export const APP_CONFIG = Symbol("APP_CONFIG");

const readNumber = (env: Environment, name: string, fallback: number): number => {
  const value = Number(env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

export const loadAppConfig = (env: Environment, startedAt: Date): AppConfig => ({
  startedAt,
  api: {
    host: env["API_HOST"] || "127.0.0.1",
    port: readNumber(env, "API_PORT", 3001),
    corsOrigins: (env["CORS_ORIGIN"] || "http://localhost:5173")
      .split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
    heartbeatMs: 15_000,
  },
  history: {
    databaseUrl: env["DATABASE_URL"] || undefined,
    sqlitePath: env["LESSFOMO_DB_PATH"] || "data/lessfomo.db",
  },
  screening: {
    evaluationDelayMs: readNumber(env, "EVALUATION_DELAY_MS", 60_000),
    minIntervalMs: readNumber(env, "MIN_INTERVAL_MS", 4_000),
    maxPending: readNumber(env, "MAX_PENDING", 50),
  },
  momentum: {
    trackingWindowMs: readNumber(env, "TRACKING_WINDOW_MS", 60 * 60_000),
    reportIntervalMs: 60_000,
    topMovers: 5,
  },
  solana: {
    rpcUrl: env["SOLANA_RPC_URL"] || undefined,
    wsUrl: env["SOLANA_WS_URL"] || undefined,
  },
});
