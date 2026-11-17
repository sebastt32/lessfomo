import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { MomentumSnapshot } from "../../../momentum/application/momentum-tracker.js";
import type { Trade } from "../../../momentum/domain/trade.js";
import type { ScreeningResult } from "../../../screening/token-screener.js";
import type { NewToken } from "../../../token-discovery/domain/new-token.js";
import type { TokenSnapshot, TradeWindow } from "../../../snapshots/domain/assemble-snapshot.js";
import type {
  DueToken,
  MarketUpdate,
  SnapshotHolders,
  SnapshotStateChange,
  SnapshotStore,
  WatchedToken,
} from "../../../snapshots/domain/snapshot-store.js";
import type { HistoryReader, StoredScreening, TokenChart, TokenHistory } from "../../domain/history-reader.js";
import type { HistoryRecorder } from "../../domain/history-recorder.js";
import type {
  HistoryStats,
  TokenCatalogReader,
  TokenList,
  TokenListQuery,
  TokenSnapshots,
} from "../../domain/token-catalog-reader.js";
import {
  backfillTokenStateSql,
  dueTokensStatement,
  lastPriceSql,
  lifecycleOf,
  markDeadStatement,
  marketUpdateStatement,
  maxScoreStatement,
  saveSnapshotStatements,
  scheduleNewTokenStatement,
  screeningStateStatement,
  snapshotHoldersStatements,
  statsStatement,
  tokenLifecycleStatement,
  tokenListStatements,
  tokenSnapshotsDdl,
  tokenSnapshotsSql,
  tokenStateDdl,
  toDueToken,
  toStats,
  toTokenListEntry,
  toTokenSnapshot,
  toTradeWindow,
  toWatchedToken,
  tradeWindowParams,
  tradeWindowSql,
  watchedTokensStatement,
  type CatalogDialect,
  type Statement,
} from "../catalog-sql.js";
import type { ReputationStats } from "../../../wallet-reputation/domain/closed-result.js";
import type { WalletRecord } from "../../../wallet-reputation/domain/reputation-rules.js";
import type { ObservedTrade } from "../../../wallet-reputation/domain/wallet-positions.js";
import type {
  ClosableToken,
  SmartWalletEntry,
  StoredOutcome,
  StoredWalletResult,
  TokenClose,
  WalletBuy,
  WalletReputationStore,
  SmartWalletsSummary,
} from "../../../wallet-reputation/domain/wallet-reputation-store.js";
import { NO_SMART_WALLETS } from "../../../wallet-reputation/domain/wallet-reputation-store.js";
import {
  chunked,
  closableTokensStatement,
  firstScreeningSql,
  hasWalletResultsSql,
  newestFirstBuy,
  saveSmartWalletStatements,
  saveTokenCloseStatements,
  saveWalletRecordsStatements,
  smartWalletOutcomesStatement,
  smartWalletRecordsStatement,
  staleWalletsStatement,
  statsAtBuysStatement,
  toClosableToken,
  toFirstScreeningAt,
  tokenSmartSummarySql,
  tokenSmartWalletsSql,
  mintsWithSmartWalletsStatement,
  mintsWithConvictionWalletsStatement,
  convictionOutcomesStatement,
  walletReputationAddedColumns,
  WALLET_REPUTATION_ADDED_INDEXES,
  tokenTradesSql,
  toObservedTrade,
  toSmartWalletEntry,
  toStatsEntry,
  toStoredOutcome,
  toStoredWalletResult,
  toWalletRecord,
  walletReputationDdl,
  walletResultsStatement,
  WALLETS_PER_QUERY,
} from "../wallet-reputation-sql.js";
import type { SessionStore } from "../../../auth/domain/session-store.js";
import type { Session, SessionWithUser, User } from "../../../auth/domain/user.js";
import type { NewUser, PasswordChange, UserStore } from "../../../auth/domain/user-store.js";
import {
  AUTH_ADDED_COLUMNS,
  authDdl,
  createSessionStatement,
  createVerifiedSessionStatement,
  createUserStatement,
  deleteExpiredSessionsStatement,
  deleteSessionStatement,
  deleteUserSessionsStatement,
  sessionStatement,
  keepSessionStatement,
  replacePasswordStatement,
  setPasswordHashStatement,
  toSessionWithUser,
  toUser,
  touchSessionStatement,
  userByIdStatement,
  userByUsernameStatement,
} from "../auth-sql.js";
import { DEFAULT_STYLE_RULES } from "../../../wallet-reputation/domain/reputation-rules.js";
import type { CycleSample } from "../../../token-cycle/domain/cycle-analysis.js";
import type { CycleState, SnapshotPoint, TradeCursor, TradePoint } from "../../../token-cycle/domain/token-cycle.js";
import type {
  CycleBacklogCursor,
  CycleToken,
  FollowedCycle,
  StoredCycle,
  TokenCycleStore,
} from "../../../token-cycle/domain/token-cycle-store.js";
import { toStoredCycle } from "../token-cycle-rows.js";
import {
  appearanceAtStatement,
  createCycleStatement,
  cycleSamplesStatement,
  cycleSnapshotsStatement,
  cycleTokenSql,
  cycleTradesStatement,
  recentCyclesStatement,
  saveCycleStatement,
  toCycleSample,
  toCycleToken,
  toFollowedCycle,
  tokenCycleSql,
  tokenCyclesDdl,
  tokensMissingCycleStatement,
  toSnapshotPoints,
  toTradePoints,
} from "../token-cycle-sql.js";
import {
  candlesSql,
  devTradesSql,
  momentumValues,
  recentScreeningsParams,
  recentScreeningsSql,
  SCREENING_COLUMNS,
  SCREENINGS_WITH_TOKEN,
  screeningValues,
  toMomentumPoint,
  toScreening,
  toSmartWalletsSummary,
  toToken,
  tokenValues,
  toCandle,
  toDateOrNull,
  toDevTrade,
  tradeValues,
  type ChartDialect,
  type SqlValue,
} from "../history-rows.js";

/** All timestamps are stored as Unix epoch milliseconds. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS tokens (
  mint TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  name TEXT NOT NULL,
  creator TEXT NOT NULL,
  bonding_curve TEXT NOT NULL,
  metadata_uri TEXT NOT NULL,
  create_signature TEXT NOT NULL,
  initial_buy_sol REAL NOT NULL,
  market_cap_sol REAL NOT NULL,
  detected_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS screenings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT NOT NULL,
  evaluated_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  failure_codes TEXT,
  top10_pct REAL,
  creator_pct REAL,
  total_holders INTEGER
);
CREATE INDEX IF NOT EXISTS screenings_mint ON screenings (mint);

CREATE TABLE IF NOT EXISTS trades (
  signature TEXT NOT NULL,
  mint TEXT NOT NULL,
  trader TEXT NOT NULL,
  side TEXT NOT NULL,
  sol_amount REAL NOT NULL,
  token_amount REAL NOT NULL,
  price_sol REAL NOT NULL,
  timestamp INTEGER NOT NULL,
  UNIQUE (signature, mint, trader, side, sol_amount, token_amount)
);
CREATE INDEX IF NOT EXISTS trades_mint_time ON trades (mint, timestamp);

CREATE TABLE IF NOT EXISTS momentum_snapshots (
  mint TEXT NOT NULL,
  at INTEGER NOT NULL,
  score INTEGER NOT NULL,
  activity REAL NOT NULL,
  acceleration REAL NOT NULL,
  buy_pressure REAL NOT NULL,
  unique_buyers_1m INTEGER NOT NULL,
  unique_buyers_5m INTEGER NOT NULL,
  avg_unique_buyers_prev REAL NOT NULL,
  buy_volume_sol_5m REAL NOT NULL,
  sell_volume_sol_5m REAL NOT NULL,
  trade_count_5m INTEGER NOT NULL,
  median_buy_sol_5m REAL NOT NULL,
  price_change_5m_pct REAL NOT NULL,
  last_price_sol REAL,
  PRIMARY KEY (mint, at)
);
CREATE INDEX IF NOT EXISTS momentum_at ON momentum_snapshots (at);
${tokenStateDdl({ real: "REAL", time: "INTEGER" })}
${tokenSnapshotsDdl({ id: "INTEGER PRIMARY KEY AUTOINCREMENT", real: "REAL", time: "INTEGER" })}
${walletReputationDdl({ real: "REAL", time: "INTEGER" })}
${authDdl({ time: "INTEGER" })}
${tokenCyclesDdl({ real: "REAL", time: "INTEGER" })}
`;

const CHART_DIALECT: ChartDialect = { param: (index) => `?${index}`, sequence: "rowid" };
/** SQLite infers nothing from placeholders, so typed ones are plain. */
const CATALOG_DIALECT: CatalogDialect = { ...CHART_DIALECT, typed: (index) => `?${index}` };

/** Stores and reads history in a local SQLite file using Node's built-in driver (no dependencies). */
export class SqliteHistoryRecorder
  implements HistoryRecorder, HistoryReader, SnapshotStore, TokenCatalogReader, WalletReputationStore, UserStore, SessionStore, TokenCycleStore
{
  private readonly db: DatabaseSync;
  private readonly insertToken: StatementSync;
  private readonly insertScreening: StatementSync;
  private readonly insertTrade: StatementSync;
  private readonly insertMomentum: StatementSync;

  /** @param path File path, or ":memory:" for an in-memory database. */
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // Waits instead of failing when another process (create-superadmin next to the running app) holds the write lock.
    this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    this.db.exec(SCHEMA);
    this.addColumns();
    this.db.exec(backfillTokenStateSql(CHART_DIALECT));

    this.insertToken = this.db.prepare(
      `INSERT OR IGNORE INTO tokens VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.insertScreening = this.db.prepare(
      `INSERT INTO screenings (${SCREENING_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.insertTrade = this.db.prepare(`INSERT OR IGNORE INTO trades VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    this.insertMomentum = this.db.prepare(
      `INSERT OR REPLACE INTO momentum_snapshots VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
  }

  async recordToken(token: NewToken): Promise<void> {
    this.transaction(() => {
      this.insertToken.run(...tokenValues(token));
      this.run(scheduleNewTokenStatement(CATALOG_DIALECT, token.mint, token.detectedAt));
    });
  }

  async recordScreening(result: ScreeningResult, evaluatedAt: Date): Promise<void> {
    this.transaction(() => {
      this.insertScreening.run(...screeningValues(result, evaluatedAt));
      const holders = result.report?.metrics.totalHolders ?? null;
      this.run(screeningStateStatement(CATALOG_DIALECT, result.token.mint, result.status, holders));
    });
  }

  async recordTrade(trade: Trade): Promise<void> {
    this.insertTrade.run(...tradeValues(trade));
  }

  async recordMomentum(snapshot: MomentumSnapshot): Promise<void> {
    this.transaction(() => {
      this.insertMomentum.run(...momentumValues(snapshot));
      this.run(maxScoreStatement(CATALOG_DIALECT, snapshot.mint, snapshot.momentum.score));
    });
  }

  async recentScreenings(limit: number, minSmartWallets = 0, minConvictionWallets = 0): Promise<StoredScreening[]> {
    const params = recentScreeningsParams(limit, minSmartWallets, minConvictionWallets);
    return this.query(recentScreeningsSql(CHART_DIALECT, minSmartWallets, minConvictionWallets), ...params).map(toScreening);
  }

  async tokenHistory(mint: string): Promise<TokenHistory | null> {
    const tokenRow = this.query("SELECT * FROM tokens WHERE mint = ?", mint)[0];
    if (tokenRow === undefined) return null;

    const screenings = this.query(
      `${SCREENINGS_WITH_TOKEN} WHERE s.mint = ? ORDER BY s.evaluated_at DESC, s.id DESC`,
      mint,
    ).map(toScreening);
    const momentum = this.query("SELECT * FROM momentum_snapshots WHERE mint = ? ORDER BY at ASC", mint).map(
      toMomentumPoint,
    );

    return { token: toToken(tokenRow), status: screenings[0]?.status ?? "pending", screenings, momentum };
  }

  async tokenChart(mint: string, intervalSeconds: number, limit: number): Promise<TokenChart | null> {
    if (this.query("SELECT 1 FROM tokens WHERE mint = ?", mint).length === 0) return null;
    return {
      candles: this.query(candlesSql(CHART_DIALECT), mint, intervalSeconds, limit).map(toCandle),
      devTrades: this.query(devTradesSql(CHART_DIALECT), mint).map(toDevTrade),
    };
  }

  async listTokens(query: TokenListQuery): Promise<TokenList> {
    const { list, count } = tokenListStatements(CATALOG_DIALECT, query);
    return {
      tokens: this.rows(list).map(toTokenListEntry),
      total: Number(this.rows(count)[0]?.["n"] ?? 0),
    };
  }

  async tokenSnapshots(mint: string, now: Date): Promise<TokenSnapshots | null> {
    const token = this.rows(tokenLifecycleStatement(CATALOG_DIALECT, mint, now))[0];
    if (token === undefined) return null;
    return { lifecycle: lifecycleOf(token), snapshots: this.query(tokenSnapshotsSql(CHART_DIALECT), mint).map(toTokenSnapshot) };
  }

  async stats(now: Date): Promise<HistoryStats> {
    return toStats(this.rows(statsStatement(CATALOG_DIALECT, now))[0]);
  }

  async dueTokens(now: Date, limit: number): Promise<DueToken[]> {
    return this.rows(dueTokensStatement(CATALOG_DIALECT, now, limit)).map(toDueToken);
  }

  async watchedTokens(since: Date, limit: number): Promise<WatchedToken[]> {
    return this.rows(watchedTokensStatement(CATALOG_DIALECT, since, limit)).map(toWatchedToken);
  }

  async tradeWindow(mint: string, after: Date | null, upTo: Date): Promise<TradeWindow> {
    const totals = this.query(tradeWindowSql(CHART_DIALECT), ...tradeWindowParams(mint, after, upTo))[0];
    const price = this.query(lastPriceSql(CHART_DIALECT), mint, upTo.getTime())[0];
    return toTradeWindow(totals, price);
  }

  async saveSnapshot(snapshot: TokenSnapshot, change: SnapshotStateChange): Promise<void> {
    this.transaction(() => saveSnapshotStatements(CATALOG_DIALECT, snapshot, change).forEach((statement) => this.run(statement)));
  }

  async markDead(mint: string): Promise<void> {
    this.run(markDeadStatement(CATALOG_DIALECT, mint));
  }

  async updateMarkets(updates: readonly MarketUpdate[]): Promise<void> {
    this.transaction(() => updates.forEach((update) => this.run(marketUpdateStatement(CATALOG_DIALECT, update))));
  }

  async addSnapshotHolders(mint: string, milestone: string, at: Date, holders: SnapshotHolders): Promise<void> {
    this.transaction(() =>
      snapshotHoldersStatements(CATALOG_DIALECT, mint, milestone, at, holders).forEach((statement) => this.run(statement)),
    );
  }

  async closableTokens(from: Date | null, upTo: Date, limit: number): Promise<ClosableToken[]> {
    return this.rows(closableTokensStatement(CATALOG_DIALECT, from, upTo, limit)).map(toClosableToken);
  }

  async tokenTrades(mint: string): Promise<ObservedTrade[]> {
    return this.query(tokenTradesSql(CHART_DIALECT), mint).map(toObservedTrade);
  }

  async firstScreeningAt(mint: string): Promise<Date | null> {
    return toFirstScreeningAt(this.query(firstScreeningSql(CHART_DIALECT), mint)[0]);
  }

  async statsAtBuys(
    buys: readonly WalletBuy[],
    lookbackMs: number,
    excludedMint: string,
    flipWindowMs = DEFAULT_STYLE_RULES.flipWindowMs,
  ): Promise<Map<string, ReputationStats>> {
    const stats = new Map<string, ReputationStats>();
    for (const chunk of chunked(buys, WALLETS_PER_QUERY)) {
      for (const row of this.rows(statsAtBuysStatement(CATALOG_DIALECT, chunk, lookbackMs, excludedMint, flipWindowMs))) {
        stats.set(...toStatsEntry(row));
      }
    }
    return stats;
  }

  async saveTokenClose(close: TokenClose): Promise<void> {
    this.transaction(() => saveTokenCloseStatements(CATALOG_DIALECT, close).forEach((statement) => this.run(statement)));
  }

  async walletResults(wallets: readonly string[], since: Date): Promise<StoredWalletResult[]> {
    return chunked(wallets, WALLETS_PER_QUERY)
      .flatMap((chunk) => this.rows(walletResultsStatement(CATALOG_DIALECT, chunk, since)).map(toStoredWalletResult))
      .sort(newestFirstBuy);
  }

  async hasWalletResults(wallet: string): Promise<boolean> {
    return this.query(hasWalletResultsSql(CHART_DIALECT), wallet).length > 0;
  }

  async saveWalletRecords(records: readonly WalletRecord[]): Promise<void> {
    this.transaction(() => saveWalletRecordsStatements(CATALOG_DIALECT, records).forEach((statement) => this.run(statement)));
  }

  async staleWallets(updatedBefore: Date, limit: number): Promise<string[]> {
    return this.rows(staleWalletsStatement(CATALOG_DIALECT, updatedBefore, limit)).map((row) => String(row["wallet"]));
  }

  async smartWalletRecords(limit: number): Promise<WalletRecord[]> {
    return this.rows(smartWalletRecordsStatement(CATALOG_DIALECT, limit)).map(toWalletRecord);
  }

  async saveSmartWallet(mint: string, entry: SmartWalletEntry): Promise<void> {
    this.transaction(() => saveSmartWalletStatements(CATALOG_DIALECT, mint, entry).forEach((statement) => this.run(statement)));
  }

  async tokenSmartWallets(mint: string): Promise<SmartWalletEntry[]> {
    return this.query(tokenSmartWalletsSql(CHART_DIALECT), mint).map(toSmartWalletEntry);
  }

  async tokenSmartSummary(mint: string): Promise<SmartWalletsSummary> {
    const row = (this.query(tokenSmartSummarySql(CHART_DIALECT), mint))[0];
    return row === undefined ? NO_SMART_WALLETS : toSmartWalletsSummary(row);
  }

  async mintsWithSmartWallets(mints: readonly string[], minSmartWallets: number): Promise<Set<string>> {
    const found = new Set<string>();
    for (const chunk of chunked(mints, WALLETS_PER_QUERY)) {
      for (const row of this.rows(mintsWithSmartWalletsStatement(CATALOG_DIALECT, chunk, minSmartWallets))) found.add(String(row["mint"]));
    }
    return found;
  }

  async mintsWithConvictionWallets(mints: readonly string[], minConvictionWallets: number): Promise<Set<string>> {
    const found = new Set<string>();
    for (const chunk of chunked(mints, WALLETS_PER_QUERY)) {
      for (const row of this.rows(mintsWithConvictionWalletsStatement(CATALOG_DIALECT, chunk, minConvictionWallets))) {
        found.add(String(row["mint"]));
      }
    }
    return found;
  }

  async smartWalletOutcomes(from: Date, to: Date): Promise<StoredOutcome[]> {
    return this.rows(smartWalletOutcomesStatement(CATALOG_DIALECT, from, to)).map(toStoredOutcome);
  }

  async convictionOutcomes(from: Date, to: Date): Promise<StoredOutcome[]> {
    return this.rows(convictionOutcomesStatement(CATALOG_DIALECT, from, to)).map(toStoredOutcome);
  }

  async cycleToken(mint: string): Promise<CycleToken | null> {
    const [row] = this.query(cycleTokenSql(CHART_DIALECT), mint);
    return row === undefined ? null : toCycleToken(row);
  }

  async appearanceAt(mint: string, minConvictionWallets: number): Promise<Date | null> {
    return toDateOrNull(this.rows(appearanceAtStatement(CATALOG_DIALECT, mint, minConvictionWallets))[0]?.["first_buy_at"]);
  }

  async createCycle(mint: string, appearedAt: Date, now: Date): Promise<{ cycle: StoredCycle; created: boolean }> {
    const created = this.rows(createCycleStatement(CATALOG_DIALECT, mint, appearedAt, now)).length > 0;
    const [row] = this.query(tokenCycleSql(CHART_DIALECT), mint);
    if (row === undefined) throw new Error(`token cycle of ${mint} was not stored`);
    return { cycle: toStoredCycle(row), created };
  }

  async tokenCycle(mint: string): Promise<StoredCycle | null> {
    const [row] = this.query(tokenCycleSql(CHART_DIALECT), mint);
    return row === undefined ? null : toStoredCycle(row);
  }

  async saveCycle(mint: string, state: CycleState, caughtUp: boolean, updatedAt: Date): Promise<void> {
    this.run(saveCycleStatement(CATALOG_DIALECT, mint, state, caughtUp, updatedAt));
  }

  async cycleTrades(mint: string, after: TradeCursor | null, limit: number): Promise<TradePoint[]> {
    return toTradePoints(this.rows(cycleTradesStatement(CATALOG_DIALECT, mint, after, limit)), after);
  }

  async cycleSnapshots(mint: string, after: Date | null, limit: number): Promise<SnapshotPoint[]> {
    return toSnapshotPoints(this.rows(cycleSnapshotsStatement(CATALOG_DIALECT, mint, after, limit)));
  }

  async tokensMissingCycle(minConvictionWallets: number, before: CycleBacklogCursor | null, limit: number): Promise<CycleToken[]> {
    return this.rows(tokensMissingCycleStatement(CATALOG_DIALECT, minConvictionWallets, before, limit)).map(toCycleToken);
  }

  async recentCycles(detectedAfter: Date, limit: number): Promise<FollowedCycle[]> {
    return this.rows(recentCyclesStatement(CATALOG_DIALECT, detectedAfter, limit)).map(toFollowedCycle);
  }

  async cycleSamples(from: Date, to: Date): Promise<CycleSample[]> {
    return this.rows(cycleSamplesStatement(CATALOG_DIALECT, from, to)).map(toCycleSample);
  }

  async createUser(user: NewUser): Promise<boolean> {
    return this.rows(createUserStatement(CHART_DIALECT, user)).length > 0;
  }

  async findUserByUsername(username: string): Promise<User | null> {
    const [row] = this.rows(userByUsernameStatement(CHART_DIALECT, username));
    return row === undefined ? null : toUser(row);
  }

  async findUserById(id: string): Promise<User | null> {
    const [row] = this.rows(userByIdStatement(CHART_DIALECT, id));
    return row === undefined ? null : toUser(row);
  }

  async setPasswordHash(userId: string, passwordHash: string, updatedAt: Date): Promise<void> {
    this.run(setPasswordHashStatement(CHART_DIALECT, userId, passwordHash, updatedAt));
  }

  async replacePassword(change: PasswordChange): Promise<string[] | null> {
    return this.transaction(() => {
      if (this.rows(replacePasswordStatement(CHART_DIALECT, change)).length === 0) return null;
      if (change.keepTokenHash !== null) this.run(keepSessionStatement(CHART_DIALECT, change.userId, change.keepTokenHash));
      return this.rows(deleteUserSessionsStatement(CHART_DIALECT, change.userId, change.keepTokenHash)).map((row) => String(row["token_hash"]));
    });
  }

  async createSession(session: Session): Promise<void> {
    this.run(createSessionStatement(CHART_DIALECT, session));
  }

  async createVerifiedSession(session: Session, verifiedPasswordHash: string): Promise<boolean> {
    return this.rows(createVerifiedSessionStatement(CATALOG_DIALECT, session, verifiedPasswordHash)).length > 0;
  }

  async findSession(tokenHash: string): Promise<SessionWithUser | null> {
    const [row] = this.rows(sessionStatement(CHART_DIALECT, tokenHash));
    return row === undefined ? null : toSessionWithUser(row);
  }

  async touchSession(tokenHash: string, lastSeenAt: Date, expiresAt: Date): Promise<void> {
    this.run(touchSessionStatement(CHART_DIALECT, tokenHash, lastSeenAt, expiresAt));
  }

  async deleteSession(tokenHash: string): Promise<void> {
    this.run(deleteSessionStatement(CHART_DIALECT, tokenHash));
  }

  async deleteUserSessions(userId: string, exceptTokenHash: string | null): Promise<string[]> {
    return this.rows(deleteUserSessionsStatement(CHART_DIALECT, userId, exceptTokenHash)).map((row) => String(row["token_hash"]));
  }

  async deleteExpiredSessions(now: Date, limit: number): Promise<number> {
    return this.rows(deleteExpiredSessionsStatement(CHART_DIALECT, now, limit)).length;
  }

  /** Adds the columns of later versions to existing derived tables and to users and sessions, once (SQLite has no ADD COLUMN IF NOT EXISTS). */
  private addColumns(): void {
    for (const { table, column, definition } of [...walletReputationAddedColumns({ real: "REAL", time: "INTEGER" }), ...AUTH_ADDED_COLUMNS]) {
      const exists = this.query(`SELECT 1 AS found FROM pragma_table_info(?) WHERE name = ?`, table, column).length > 0;
      if (!exists) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
    this.db.exec(WALLET_REPUTATION_ADDED_INDEXES);
  }

  /** Runs a query and returns plain rows; intended for analysis scripts and tests. */
  query(sql: string, ...params: SqlValue[]): Record<string, unknown>[] {
    return this.db.prepare(sql).all(...params).map((row) => ({ ...row }));
  }

  async close(): Promise<void> {
    this.db.close();
  }

  private rows(statement: Statement): Record<string, unknown>[] {
    return this.query(statement.sql, ...statement.params);
  }

  private run(statement: Statement): void {
    this.db.prepare(statement.sql).run(...statement.params);
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
