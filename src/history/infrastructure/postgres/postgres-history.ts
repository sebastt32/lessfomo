import pg from "pg";
import type { MomentumSnapshot } from "../../../momentum/application/momentum-tracker.js";
import type { Trade } from "../../../momentum/domain/trade.js";
import type { ScreeningResult } from "../../../screening/token-screener.js";
import type { NewToken } from "../../../token-discovery/domain/new-token.js";
import type { HistoryReader, StoredScreening, TokenHistory } from "../../domain/history-reader.js";
import type { HistoryRecorder } from "../../domain/history-recorder.js";
import {
  momentumValues,
  SCREENING_COLUMNS,
  SCREENINGS_WITH_TOKEN,
  screeningValues,
  toMomentumPoint,
  toScreening,
  toToken,
  tokenValues,
  tradeValues,
  type Row,
  type SqlValue,
} from "../history-rows.js";

/** Same tables and columns as the SQLite adapter. Timestamps are Unix epoch milliseconds. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS tokens (
  mint TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  name TEXT NOT NULL,
  creator TEXT NOT NULL,
  bonding_curve TEXT NOT NULL,
  metadata_uri TEXT NOT NULL,
  create_signature TEXT NOT NULL,
  initial_buy_sol DOUBLE PRECISION NOT NULL,
  market_cap_sol DOUBLE PRECISION NOT NULL,
  detected_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS screenings (
  id BIGSERIAL PRIMARY KEY,
  mint TEXT NOT NULL,
  evaluated_at BIGINT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  failure_codes TEXT,
  top10_pct DOUBLE PRECISION,
  creator_pct DOUBLE PRECISION,
  total_holders INTEGER
);
CREATE INDEX IF NOT EXISTS screenings_mint ON screenings (mint);
CREATE INDEX IF NOT EXISTS screenings_evaluated_at ON screenings (evaluated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS trades (
  signature TEXT NOT NULL,
  mint TEXT NOT NULL,
  trader TEXT NOT NULL,
  side TEXT NOT NULL,
  sol_amount DOUBLE PRECISION NOT NULL,
  token_amount DOUBLE PRECISION NOT NULL,
  price_sol DOUBLE PRECISION NOT NULL,
  timestamp BIGINT NOT NULL,
  UNIQUE (signature, mint, trader, side, sol_amount, token_amount)
);
CREATE INDEX IF NOT EXISTS trades_mint_time ON trades (mint, timestamp);

CREATE TABLE IF NOT EXISTS momentum_snapshots (
  mint TEXT NOT NULL,
  at BIGINT NOT NULL,
  score INTEGER NOT NULL,
  activity DOUBLE PRECISION NOT NULL,
  acceleration DOUBLE PRECISION NOT NULL,
  buy_pressure DOUBLE PRECISION NOT NULL,
  unique_buyers_1m INTEGER NOT NULL,
  unique_buyers_5m INTEGER NOT NULL,
  avg_unique_buyers_prev DOUBLE PRECISION NOT NULL,
  buy_volume_sol_5m DOUBLE PRECISION NOT NULL,
  sell_volume_sol_5m DOUBLE PRECISION NOT NULL,
  trade_count_5m INTEGER NOT NULL,
  median_buy_sol_5m DOUBLE PRECISION NOT NULL,
  price_change_5m_pct DOUBLE PRECISION NOT NULL,
  last_price_sol DOUBLE PRECISION,
  PRIMARY KEY (mint, at)
);
CREATE INDEX IF NOT EXISTS momentum_at ON momentum_snapshots (at);
`;

/** Serializes concurrent migrations (e.g. two containers starting during a redeploy). */
const MIGRATION_LOCK_ID = 727_001;

/** `$1, $2, ..., $n` */
const placeholders = (count: number): string => Array.from({ length: count }, (_, i) => `$${i + 1}`).join(", ");

const MOMENTUM_COLUMNS = [
  "mint",
  "at",
  "score",
  "activity",
  "acceleration",
  "buy_pressure",
  "unique_buyers_1m",
  "unique_buyers_5m",
  "avg_unique_buyers_prev",
  "buy_volume_sol_5m",
  "sell_volume_sol_5m",
  "trade_count_5m",
  "median_buy_sol_5m",
  "price_change_5m_pct",
  "last_price_sol",
];

const INSERT_TOKEN = `INSERT INTO tokens VALUES (${placeholders(10)}) ON CONFLICT (mint) DO NOTHING`;
const INSERT_SCREENING = `INSERT INTO screenings (${SCREENING_COLUMNS}) VALUES (${placeholders(8)})`;
const INSERT_TRADE = `INSERT INTO trades VALUES (${placeholders(8)})
  ON CONFLICT (signature, mint, trader, side, sol_amount, token_amount) DO NOTHING`;
const UPSERT_MOMENTUM = `INSERT INTO momentum_snapshots (${MOMENTUM_COLUMNS.join(", ")})
  VALUES (${placeholders(MOMENTUM_COLUMNS.length)})
  ON CONFLICT (mint, at) DO UPDATE SET ${MOMENTUM_COLUMNS.slice(2)
    .map((column) => `${column} = EXCLUDED.${column}`)
    .join(", ")}`;

export interface PostgresHistoryOptions {
  /** Called when an idle pooled connection fails (e.g. the server restarts); without it such errors are ignored. */
  readonly onError?: (error: Error) => void;
}

/** Stores and reads history in PostgreSQL. Every query is parameterized. */
export class PostgresHistory implements HistoryRecorder, HistoryReader {
  private constructor(private readonly pool: pg.Pool) {}

  /** Connects and creates the schema if it does not exist yet. Rejects if the server is unreachable. */
  static async connect(connectionString: string, options: PostgresHistoryOptions = {}): Promise<PostgresHistory> {
    // Bounded waits: a database that drops packets must not hang API requests or pile up writes.
    const pool = new pg.Pool({
      connectionString,
      max: 10,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: 15_000,
      query_timeout: 20_000,
    });
    pool.on("error", (error) => options.onError?.(error));
    try {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_ID]);
        await client.query(SCHEMA);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      await pool.end().catch(() => {});
      throw error;
    }
    return new PostgresHistory(pool);
  }

  async recordToken(token: NewToken): Promise<void> {
    await this.pool.query(INSERT_TOKEN, tokenValues(token));
  }

  async recordScreening(result: ScreeningResult, evaluatedAt: Date): Promise<void> {
    await this.pool.query(INSERT_SCREENING, screeningValues(result, evaluatedAt));
  }

  async recordTrade(trade: Trade): Promise<void> {
    await this.pool.query(INSERT_TRADE, tradeValues(trade));
  }

  async recordMomentum(snapshot: MomentumSnapshot): Promise<void> {
    await this.pool.query(UPSERT_MOMENTUM, momentumValues(snapshot));
  }

  async recentScreenings(limit: number): Promise<StoredScreening[]> {
    const rows = await this.query(`${SCREENINGS_WITH_TOKEN} ORDER BY s.evaluated_at DESC, s.id DESC LIMIT $1`, limit);
    return rows.map(toScreening);
  }

  async tokenHistory(mint: string): Promise<TokenHistory | null> {
    const tokenRow = (await this.query("SELECT * FROM tokens WHERE mint = $1", mint))[0];
    if (tokenRow === undefined) return null;

    const [screeningRows, momentumRows] = await Promise.all([
      this.query(`${SCREENINGS_WITH_TOKEN} WHERE s.mint = $1 ORDER BY s.evaluated_at DESC, s.id DESC`, mint),
      this.query("SELECT * FROM momentum_snapshots WHERE mint = $1 ORDER BY at ASC", mint),
    ]);
    const screenings = screeningRows.map(toScreening);

    return {
      token: toToken(tokenRow),
      status: screenings[0]?.status ?? "pending",
      screenings,
      momentum: momentumRows.map(toMomentumPoint),
    };
  }

  /**
   * Runs a parameterized query (`$1`, `$2`, ...) and returns plain rows; intended for analysis
   * scripts and tests. BIGINT columns (timestamps, ids) come back as strings.
   */
  async query(sql: string, ...params: SqlValue[]): Promise<Row[]> {
    const result = await this.pool.query(sql, params);
    return result.rows as Row[];
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
