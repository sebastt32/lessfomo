import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { MomentumSnapshot } from "../../../momentum/application/momentum-tracker.js";
import type { Trade } from "../../../momentum/domain/trade.js";
import type { ScreeningResult } from "../../../screening/token-screener.js";
import type { NewToken } from "../../../token-discovery/domain/new-token.js";
import type {
  HistoryReader,
  StoredMomentumPoint,
  StoredScreening,
  StoredToken,
  TokenHistory,
} from "../../domain/history-reader.js";
import type { HistoryRecorder } from "../../domain/history-recorder.js";

type Row = Record<string, unknown>;

const numberOrNull = (value: unknown): number | null => (typeof value === "number" ? value : null);

const toScreening = (row: Row): StoredScreening => ({
  mint: String(row["mint"]),
  symbol: String(row["symbol"] ?? ""),
  name: String(row["name"] ?? ""),
  status: row["status"] as StoredScreening["status"],
  reason: typeof row["reason"] === "string" ? row["reason"] : null,
  failureCodes: typeof row["failure_codes"] === "string" ? (JSON.parse(row["failure_codes"]) as string[]) : [],
  top10Pct: numberOrNull(row["top10_pct"]),
  creatorPct: numberOrNull(row["creator_pct"]),
  totalHolders: numberOrNull(row["total_holders"]),
  evaluatedAt: new Date(Number(row["evaluated_at"])),
});

const toToken = (row: Row): StoredToken => ({
  mint: String(row["mint"]),
  symbol: String(row["symbol"]),
  name: String(row["name"]),
  creator: String(row["creator"]),
  metadataUri: String(row["metadata_uri"]),
  initialBuySol: Number(row["initial_buy_sol"]),
  marketCapSol: Number(row["market_cap_sol"]),
  detectedAt: new Date(Number(row["detected_at"])),
});

const toMomentumPoint = (row: Row): StoredMomentumPoint => ({
  at: new Date(Number(row["at"])),
  score: Number(row["score"]),
  components: {
    activity: Number(row["activity"]),
    acceleration: Number(row["acceleration"]),
    buyPressure: Number(row["buy_pressure"]),
  },
  metrics: {
    uniqueBuyers1m: Number(row["unique_buyers_1m"]),
    uniqueBuyers5m: Number(row["unique_buyers_5m"]),
    avgUniqueBuyersPrevMinutes: Number(row["avg_unique_buyers_prev"]),
    buyVolumeSol5m: Number(row["buy_volume_sol_5m"]),
    sellVolumeSol5m: Number(row["sell_volume_sol_5m"]),
    tradeCount5m: Number(row["trade_count_5m"]),
    medianBuySol5m: Number(row["median_buy_sol_5m"]),
    priceChange5mPct: Number(row["price_change_5m_pct"]),
    lastPriceSol: numberOrNull(row["last_price_sol"]),
  },
});

const SCREENINGS_WITH_TOKEN = `
  SELECT s.*, t.symbol, t.name FROM screenings s LEFT JOIN tokens t ON t.mint = s.mint`;

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
`;

/** Stores and reads history in a local SQLite file using Node's built-in driver (no dependencies). */
export class SqliteHistoryRecorder implements HistoryRecorder, HistoryReader {
  private readonly db: DatabaseSync;
  private readonly insertToken: StatementSync;
  private readonly insertScreening: StatementSync;
  private readonly insertTrade: StatementSync;
  private readonly insertMomentum: StatementSync;

  /** @param path File path, or ":memory:" for an in-memory database. */
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    this.db.exec(SCHEMA);

    this.insertToken = this.db.prepare(
      `INSERT OR IGNORE INTO tokens VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.insertScreening = this.db.prepare(
      `INSERT INTO screenings (mint, evaluated_at, status, reason, failure_codes, top10_pct, creator_pct, total_holders)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.insertTrade = this.db.prepare(`INSERT OR IGNORE INTO trades VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    this.insertMomentum = this.db.prepare(
      `INSERT OR REPLACE INTO momentum_snapshots VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
  }

  recordToken(token: NewToken): void {
    this.insertToken.run(
      token.mint,
      token.symbol,
      token.name,
      token.creator,
      token.bondingCurve,
      token.metadataUri,
      token.signature,
      token.initialBuySol,
      token.marketCapSol,
      token.detectedAt.getTime(),
    );
  }

  recordScreening(result: ScreeningResult, evaluatedAt: Date): void {
    const report = result.report;
    this.insertScreening.run(
      result.token.mint,
      evaluatedAt.getTime(),
      result.status,
      result.reason ?? null,
      report ? JSON.stringify(report.failures.map((f) => f.code)) : null,
      report?.metrics.top10Pct ?? null,
      report?.metrics.creatorPct ?? null,
      report?.metrics.totalHolders ?? null,
    );
  }

  recordTrade(trade: Trade): void {
    this.insertTrade.run(
      trade.signature,
      trade.mint,
      trade.trader,
      trade.side,
      trade.solAmount,
      trade.tokenAmount,
      trade.priceSol,
      trade.timestamp.getTime(),
    );
  }

  recordMomentum(snapshot: MomentumSnapshot): void {
    const { score, components, metrics } = snapshot.momentum;
    this.insertMomentum.run(
      snapshot.mint,
      snapshot.at.getTime(),
      score,
      components.activity,
      components.acceleration,
      components.buyPressure,
      metrics.uniqueBuyers1m,
      metrics.uniqueBuyers5m,
      metrics.avgUniqueBuyersPrevMinutes,
      metrics.buyVolumeSol5m,
      metrics.sellVolumeSol5m,
      metrics.tradeCount5m,
      metrics.medianBuySol5m,
      metrics.priceChange5mPct,
      metrics.lastPriceSol,
    );
  }

  recentScreenings(limit: number): StoredScreening[] {
    return this.query(`${SCREENINGS_WITH_TOKEN} ORDER BY s.evaluated_at DESC, s.id DESC LIMIT ?`, limit).map(
      toScreening,
    );
  }

  tokenHistory(mint: string): TokenHistory | null {
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

  /** Runs a query and returns plain rows; intended for analysis scripts and tests. */
  query(sql: string, ...params: (string | number | null)[]): Record<string, unknown>[] {
    return this.db.prepare(sql).all(...params).map((row) => ({ ...row }));
  }

  close(): void {
    this.db.close();
  }
}
