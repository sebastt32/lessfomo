import type { Liquidity } from "../../momentum/domain/liquidity.js";
import { DEAD_AFTER_MS, FIRST_MILESTONE } from "../../snapshots/domain/milestone-schedule.js";
import type { SnapshotSource, TokenSnapshot, TradeWindow } from "../../snapshots/domain/assemble-snapshot.js";
import { PUMP_TOTAL_SUPPLY } from "../../snapshots/domain/assemble-snapshot.js";
import type {
  DueToken,
  MarketUpdate,
  SnapshotHolders,
  SnapshotStateChange,
  TokenMarketState,
  WatchedToken,
} from "../../snapshots/domain/snapshot-store.js";
import type {
  HistoryStats,
  Lifecycle,
  SafetyStatus,
  TokenListEntry,
  TokenListQuery,
  TokenSortField,
} from "../domain/token-catalog-reader.js";
import {
  numberOrNull,
  SMART_SUMMARY_COLUMNS,
  toDate,
  toDateOrNull,
  toSmartWalletsSummary,
  toToken,
  type ChartDialect,
  type Row,
  type SqlValue,
} from "./history-rows.js";
import { CYCLE_LIST_COLUMNS, toListCycle } from "./token-cycle-rows.js";

/**
 * SQL and row mapping of the token catalog (`token_state`) and its snapshots (`token_snapshots`),
 * shared by every adapter so both engines answer identically. Both tables are new: older
 * databases get them (and a backfill of `token_state` from the existing tables) on startup.
 */

export type SqlType = "real" | "bigint" | "integer" | "text";

/** Placeholders, plus how to type a parameter whose type PostgreSQL cannot infer (e.g. `$1 IS NULL`). */
export interface CatalogDialect extends ChartDialect {
  readonly typed: (index: number, type: SqlType) => string;
}

export interface Statement {
  readonly sql: string;
  readonly params: SqlValue[];
}

/** Collects parameters and returns their placeholders, so dynamic queries stay parameterized. */
export class Params {
  readonly values: SqlValue[] = [];
  constructor(private readonly dialect: CatalogDialect) {}
  add(value: SqlValue, type?: SqlType): string {
    this.values.push(value);
    const index = this.values.length;
    return type === undefined ? this.dialect.param(index) : this.dialect.typed(index, type);
  }
}

const time = (date: Date | null): number | null => date?.getTime() ?? null;

/** Columns of `token_state` (one row per token), shared by both schemas. */
export const tokenStateDdl = (types: { real: string; time: string }): string => `
CREATE TABLE IF NOT EXISTS token_state (
  mint TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',
  lifecycle TEXT NOT NULL DEFAULT 'active',
  max_score INTEGER,
  holders INTEGER,
  holder_threshold INTEGER NOT NULL DEFAULT 0,
  liquidity_sol ${types.real},
  bonding_curve_pct ${types.real},
  migrated INTEGER NOT NULL DEFAULT 0,
  last_price_sol ${types.real},
  peak_price_sol ${types.real},
  last_trade_at ${types.time},
  last_activity_at ${types.time},
  next_milestone TEXT,
  next_snapshot_at ${types.time},
  last_milestone TEXT,
  last_snapshot_at ${types.time},
  peak_event_window TEXT
);
CREATE INDEX IF NOT EXISTS token_state_next ON token_state (next_snapshot_at) WHERE next_snapshot_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS token_state_max_score ON token_state (max_score);
CREATE INDEX IF NOT EXISTS token_state_peak ON token_state (peak_price_sol);
CREATE INDEX IF NOT EXISTS token_state_liquidity ON token_state (liquidity_sol);
CREATE INDEX IF NOT EXISTS tokens_detected_at ON tokens (detected_at);
`;

/** `token_snapshots` without its id column, whose type differs per engine. */
export const tokenSnapshotsDdl = (types: { id: string; real: string; time: string }): string => `
CREATE TABLE IF NOT EXISTS token_snapshots (
  id ${types.id},
  mint TEXT NOT NULL,
  milestone TEXT NOT NULL,
  at ${types.time} NOT NULL,
  price_sol ${types.real},
  market_cap_sol ${types.real},
  volume_sol ${types.real},
  buys INTEGER,
  sells INTEGER,
  unique_buyers INTEGER,
  holders INTEGER,
  top10_pct ${types.real},
  dev_holds_pct ${types.real},
  liquidity_sol ${types.real},
  bonding_curve_pct ${types.real},
  migrated INTEGER NOT NULL,
  source TEXT NOT NULL,
  UNIQUE (mint, milestone, at)
);
CREATE INDEX IF NOT EXISTS token_snapshots_mint_at ON token_snapshots (mint, at);
`;

/**
 * Creates the state of every token stored before `token_state` existed, from its screenings,
 * momentum and trades. Runs on every startup but only touches tokens without a state row.
 */
export const backfillTokenStateSql = ({ sequence }: ChartDialect): string => {
  const latestScreening = (column: string, extra = "") =>
    `(SELECT s.${column} FROM screenings s WHERE s.mint = t.mint${extra} ORDER BY s.evaluated_at DESC, s.id DESC LIMIT 1)`;
  return `
  INSERT INTO token_state (mint, status, max_score, holders, last_price_sol, peak_price_sol,
                           last_trade_at, last_activity_at, next_milestone, next_snapshot_at)
  SELECT t.mint,
         COALESCE(${latestScreening("status")}, 'pending'),
         (SELECT MAX(m.score) FROM momentum_snapshots m WHERE m.mint = t.mint),
         ${latestScreening("total_holders", " AND s.total_holders IS NOT NULL")},
         (SELECT r.price_sol FROM trades r WHERE r.mint = t.mint ORDER BY r.timestamp DESC, r.${sequence} DESC LIMIT 1),
         (SELECT MAX(r.price_sol) FROM trades r WHERE r.mint = t.mint),
         (SELECT MAX(r.timestamp) FROM trades r WHERE r.mint = t.mint),
         (SELECT MAX(r.timestamp) FROM trades r WHERE r.mint = t.mint),
         '${FIRST_MILESTONE}', t.detected_at
  FROM tokens t
  WHERE NOT EXISTS (SELECT 1 FROM token_state x WHERE x.mint = t.mint)`;
};

/** Schedules the first snapshot of a new token; a token detected again keeps its schedule. */
export const scheduleNewTokenStatement = (dialect: CatalogDialect, mint: string, detectedAt: Date): Statement => {
  const params = new Params(dialect);
  const sql = `
  INSERT INTO token_state (mint, next_milestone, next_snapshot_at)
  VALUES (${params.add(mint)}, '${FIRST_MILESTONE}', ${params.add(detectedAt.getTime())})
  ON CONFLICT (mint) DO UPDATE SET next_milestone = excluded.next_milestone, next_snapshot_at = excluded.next_snapshot_at
  WHERE token_state.next_milestone IS NULL AND token_state.last_milestone IS NULL AND token_state.lifecycle = 'active'`;
  return { sql, params: params.values };
};

/** Keeps the latest screening status and the latest known holder count. */
export const screeningStateStatement = (
  dialect: CatalogDialect,
  mint: string,
  status: string,
  holders: number | null,
): Statement => {
  const params = new Params(dialect);
  const sql = `
  INSERT INTO token_state (mint, status, holders) VALUES (${params.add(mint)}, ${params.add(status)}, ${params.add(holders, "integer")})
  ON CONFLICT (mint) DO UPDATE SET status = excluded.status, holders = COALESCE(excluded.holders, token_state.holders)`;
  return { sql, params: params.values };
};

export const maxScoreStatement = (dialect: CatalogDialect, mint: string, score: number): Statement => {
  const params = new Params(dialect);
  const value = params.add(score, "integer");
  return {
    sql: `UPDATE token_state SET max_score = CASE WHEN max_score IS NULL OR max_score < ${value} THEN ${value} ELSE max_score END
          WHERE mint = ${params.add(mint)}`,
    params: params.values,
  };
};

/** `column` becomes `value` only when `value` is known and greater. */
const keepGreatest = (column: string, value: string): string =>
  `${column} = CASE WHEN ${value} IS NOT NULL AND (${column} IS NULL OR ${column} < ${value}) THEN ${value} ELSE ${column} END`;

export const marketUpdateStatement = (dialect: CatalogDialect, update: MarketUpdate): Statement => {
  const params = new Params(dialect);
  const price = params.add(update.lastPriceSol, "real");
  const peak = params.add(update.peakPriceSol, "real");
  const lastTrade = params.add(time(update.lastTradeAt), "bigint");
  const lastActivity = params.add(time(update.lastActivityAt), "bigint");
  const liquidity = params.add(update.liquidity?.sol ?? null, "real");
  const curvePct = params.add(update.liquidity?.bondingCurvePct ?? null, "real");
  const migrated = params.add(update.liquidity?.migrated === true ? 1 : 0, "integer");
  const sql = `
  UPDATE token_state SET
    last_price_sol = COALESCE(${price}, last_price_sol),
    ${keepGreatest("peak_price_sol", peak)},
    ${keepGreatest("last_trade_at", lastTrade)},
    ${keepGreatest("last_activity_at", lastActivity)},
    liquidity_sol = COALESCE(${liquidity}, liquidity_sol),
    bonding_curve_pct = COALESCE(${curvePct}, bonding_curve_pct),
    migrated = CASE WHEN ${migrated} = 1 THEN 1 ELSE migrated END
  WHERE mint = ${params.add(update.mint)}`;
  return { sql, params: params.values };
};

const SNAPSHOT_COLUMNS = [
  "mint",
  "milestone",
  "at",
  "price_sol",
  "market_cap_sol",
  "volume_sol",
  "buys",
  "sells",
  "unique_buyers",
  "holders",
  "top10_pct",
  "dev_holds_pct",
  "liquidity_sol",
  "bonding_curve_pct",
  "migrated",
  "source",
];

/** Statements that store a snapshot and move the token's schedule, to run in one transaction. */
export const saveSnapshotStatements = (
  dialect: CatalogDialect,
  snapshot: TokenSnapshot,
  change: SnapshotStateChange,
): Statement[] => {
  const insert = new Params(dialect);
  const values: SqlValue[] = [
    snapshot.mint,
    snapshot.milestone,
    snapshot.at.getTime(),
    snapshot.priceSol,
    snapshot.marketCapSol,
    snapshot.volumeSol,
    snapshot.buys,
    snapshot.sells,
    snapshot.uniqueBuyers,
    snapshot.holders,
    snapshot.top10Pct,
    snapshot.devHoldsPct,
    snapshot.liquidity.sol,
    snapshot.liquidity.bondingCurvePct,
    snapshot.liquidity.migrated ? 1 : 0,
    snapshot.source,
  ];
  const insertSql = `INSERT INTO token_snapshots (${SNAPSHOT_COLUMNS.join(", ")})
    VALUES (${values.map((value) => insert.add(value)).join(", ")})
    ON CONFLICT (mint, milestone, at) DO NOTHING`;

  const update = new Params(dialect);
  const at = update.add(snapshot.at.getTime(), "bigint");
  const sets = [keepGreatest("last_snapshot_at", at)];
  if (change.next !== undefined) {
    sets.push(`next_milestone = ${update.add(change.next?.milestone ?? null, "text")}`);
    sets.push(`next_snapshot_at = ${update.add(time(change.next?.at ?? null), "bigint")}`);
  }
  if (change.lastMilestone !== undefined) sets.push(`last_milestone = ${update.add(change.lastMilestone)}`);
  if (change.peakEventWindow !== undefined) sets.push(`peak_event_window = ${update.add(change.peakEventWindow)}`);
  if (change.holderThreshold !== undefined) sets.push(`holder_threshold = ${update.add(change.holderThreshold, "integer")}`);
  const updateSql = `UPDATE token_state SET ${sets.join(", ")} WHERE mint = ${update.add(snapshot.mint)}`;

  return [
    { sql: insertSql, params: insert.values },
    { sql: updateSql, params: update.values },
  ];
};

export const markDeadStatement = (dialect: CatalogDialect, mint: string): Statement => ({
  sql: `UPDATE token_state SET lifecycle = 'dead', next_milestone = NULL, next_snapshot_at = NULL WHERE mint = ${dialect.param(1)}`,
  params: [mint],
});

export const snapshotHoldersStatements = (
  dialect: CatalogDialect,
  mint: string,
  milestone: string,
  at: Date,
  { holders, top10Pct, devHoldsPct }: SnapshotHolders,
): Statement[] => {
  const p = dialect.param;
  return [
    {
      sql: `UPDATE token_snapshots SET holders = ${p(4)}, top10_pct = ${p(5)}, dev_holds_pct = ${p(6)},
              source = CASE WHEN price_sol IS NULL AND volume_sol IS NULL AND liquidity_sol IS NULL THEN 'rugcheck' ELSE 'mixed' END
            WHERE mint = ${p(1)} AND milestone = ${p(2)} AND at = ${p(3)}`,
      params: [mint, milestone, at.getTime(), holders, top10Pct, devHoldsPct],
    },
    { sql: `UPDATE token_state SET holders = ${p(2)} WHERE mint = ${p(1)}`, params: [mint, holders] },
  ];
};

export const dueTokensStatement = (dialect: CatalogDialect, now: Date, limit: number): Statement => ({
  sql: `SELECT s.*, t.symbol, t.creator, t.bonding_curve, t.detected_at, t.market_cap_sol
        FROM token_state s JOIN tokens t ON t.mint = s.mint
        WHERE s.next_snapshot_at IS NOT NULL AND s.next_snapshot_at <= ${dialect.param(1)}
        ORDER BY s.next_snapshot_at ASC, s.mint ASC LIMIT ${dialect.param(2)}`,
  params: [now.getTime(), limit],
});

export const watchedTokensStatement = (dialect: CatalogDialect, since: Date, limit: number): Statement => ({
  sql: `SELECT s.*, t.detected_at FROM token_state s JOIN tokens t ON t.mint = s.mint
        WHERE s.next_snapshot_at IS NOT NULL AND t.detected_at >= ${dialect.param(1)}
        ORDER BY t.detected_at DESC, t.mint ASC LIMIT ${dialect.param(2)}`,
  params: [since.getTime(), limit],
});

/** Parameters: 1 = mint, 2 = after (exclusive), 3 = up to (inclusive). */
export const tradeWindowSql = ({ param }: ChartDialect): string => `
  SELECT COALESCE(SUM(sol_amount), 0) AS volume_sol,
         COALESCE(SUM(CASE WHEN side = 'buy' THEN 1 ELSE 0 END), 0) AS buys,
         COALESCE(SUM(CASE WHEN side = 'sell' THEN 1 ELSE 0 END), 0) AS sells,
         COUNT(DISTINCT CASE WHEN side = 'buy' THEN trader END) AS unique_buyers
  FROM trades WHERE mint = ${param(1)} AND timestamp > ${param(2)} AND timestamp <= ${param(3)}`;

/** Parameters: 1 = mint, 2 = up to (inclusive). */
export const lastPriceSql = ({ param, sequence }: ChartDialect): string => `
  SELECT price_sol FROM trades WHERE mint = ${param(1)} AND timestamp <= ${param(2)}
  ORDER BY timestamp DESC, ${sequence} DESC LIMIT 1`;

export const tradeWindowParams = (mint: string, after: Date | null, upTo: Date): SqlValue[] => [
  mint,
  after?.getTime() ?? -1,
  upTo.getTime(),
];

const round9 = (value: number): number => Math.round(value * 1e9) / 1e9;

export const toTradeWindow = (row: Row | undefined, priceRow: Row | undefined): TradeWindow => ({
  lastPriceSol: numberOrNull(priceRow?.["price_sol"]),
  volumeSol: round9(Number(row?.["volume_sol"] ?? 0)),
  buys: Number(row?.["buys"] ?? 0),
  sells: Number(row?.["sells"] ?? 0),
  uniqueBuyers: Number(row?.["unique_buyers"] ?? 0),
});

const toLiquidity = (row: Row): Liquidity => ({
  sol: numberOrNull(row["liquidity_sol"]),
  bondingCurvePct: numberOrNull(row["bonding_curve_pct"]),
  migrated: Number(row["migrated"] ?? 0) === 1,
});

const toMarketState = (row: Row): TokenMarketState => ({
  liquidity: toLiquidity(row),
  lastPriceSol: numberOrNull(row["last_price_sol"]),
  peakPriceSol: numberOrNull(row["peak_price_sol"]),
  lastTradeAt: toDateOrNull(row["last_trade_at"]),
  lastActivityAt: toDateOrNull(row["last_activity_at"]),
  holders: numberOrNull(row["holders"]),
  holderThreshold: Number(row["holder_threshold"] ?? 0),
  lastMilestone: typeof row["last_milestone"] === "string" ? row["last_milestone"] : null,
  peakEventWindow: typeof row["peak_event_window"] === "string" ? row["peak_event_window"] : null,
});

export const toDueToken = (row: Row): DueToken => ({
  mint: String(row["mint"]),
  symbol: String(row["symbol"]),
  creator: String(row["creator"]),
  bondingCurve: String(row["bonding_curve"]),
  detectedAt: toDate(row["detected_at"]),
  creationPriceSol: Number(row["market_cap_sol"]) / PUMP_TOTAL_SUPPLY,
  nextMilestone: String(row["next_milestone"]),
  lastSnapshotAt: toDateOrNull(row["last_snapshot_at"]),
  market: toMarketState(row),
});

export const toWatchedToken = (row: Row): WatchedToken => ({
  mint: String(row["mint"]),
  detectedAt: toDate(row["detected_at"]),
  market: toMarketState(row),
});

const toSnapshotSource = (value: unknown): SnapshotSource =>
  value === "dexscreener" || value === "rugcheck" || value === "mixed" ? value : "trades";

export const toTokenSnapshot = (row: Row): TokenSnapshot => ({
  mint: String(row["mint"]),
  milestone: String(row["milestone"]),
  at: toDate(row["at"]),
  priceSol: numberOrNull(row["price_sol"]),
  marketCapSol: numberOrNull(row["market_cap_sol"]),
  volumeSol: numberOrNull(row["volume_sol"]),
  buys: numberOrNull(row["buys"]),
  sells: numberOrNull(row["sells"]),
  uniqueBuyers: numberOrNull(row["unique_buyers"]),
  holders: numberOrNull(row["holders"]),
  top10Pct: numberOrNull(row["top10_pct"]),
  devHoldsPct: numberOrNull(row["dev_holds_pct"]),
  liquidity: toLiquidity(row),
  source: toSnapshotSource(row["source"]),
});

/** Dead when marked so, or when the latest known activity (else creation) is 24 hours old. */
const lifecycleSql = (deadBefore: string): string =>
  `(CASE WHEN s.lifecycle = 'dead' OR COALESCE(s.last_activity_at, t.detected_at) <= ${deadBefore} THEN 'dead' ELSE 'active' END)`;

const deadBefore = (now: Date): number => now.getTime() - DEAD_AFTER_MS;

const SORT_COLUMNS: Readonly<Record<TokenSortField, string>> = {
  detectedAt: "t.detected_at",
  maxScore: "s.max_score",
  peakMarketCapSol: "s.peak_price_sol",
  liquidity: "s.liquidity_sol",
  smartWallets: "w.wallets",
  convictionWallets: "w.conviction",
  appearedAt: "c.appeared_at",
  investWindow: "c.invest_window_seconds",
};

const escapeLike = (text: string): string => text.replace(/[\\%_]/g, (character) => `\\${character}`);

export interface TokenListStatements {
  readonly list: Statement;
  readonly count: Statement;
}

/** The page of tokens matching a query, and the number of matches. Filters run on indexed columns first. */
export const tokenListStatements = (dialect: CatalogDialect, query: TokenListQuery): TokenListStatements => {
  const build = (forCount: boolean): Statement => {
    const params = new Params(dialect);
    let lifecyclePlaceholder: string | null = null;
    const lifecycle = (): string => {
      lifecyclePlaceholder ??= params.add(deadBefore(query.now), "bigint");
      return lifecycleSql(lifecyclePlaceholder);
    };
    const where: string[] = [];
    const dateColumn = query.dateField === "appearedAt" ? "c.appeared_at" : "t.detected_at";
    if (query.from !== null) where.push(`${dateColumn} >= ${params.add(query.from.getTime())}`);
    if (query.to !== null) where.push(`${dateColumn} < ${params.add(query.to.getTime())}`);
    if (query.statuses.length > 0) {
      where.push(`COALESCE(s.status, 'pending') IN (${query.statuses.map((status) => params.add(status)).join(", ")})`);
    }
    if (query.lifecycle !== null) where.push(`${lifecycle()} = ${params.add(query.lifecycle)}`);
    if (query.minScore !== null) where.push(`s.max_score >= ${params.add(query.minScore, "real")}`);
    if (query.minSmartWallets > 0) where.push(`w.wallets >= ${params.add(query.minSmartWallets, "integer")}`);
    const minConviction = query.minConvictionWallets ?? 0;
    if (minConviction > 0) where.push(`w.conviction >= ${params.add(minConviction, "integer")}`);
    const phases = query.phases ?? [];
    if (phases.length > 0) where.push(`c.phase IN (${phases.map((phase) => params.add(phase)).join(", ")})`);
    if (query.appearedLate !== undefined && query.appearedLate !== null) {
      where.push(`c.appeared_late = ${params.add(query.appearedLate ? 1 : 0, "integer")}`);
    }
    if (query.search !== null) {
      const text = escapeLike(query.search.toLowerCase());
      const contains = params.add(`%${text}%`);
      const prefix = params.add(`${text}%`);
      where.push(
        `(LOWER(t.symbol) LIKE ${contains} ESCAPE '\\' OR LOWER(t.name) LIKE ${contains} ESCAPE '\\' OR LOWER(t.mint) LIKE ${prefix} ESCAPE '\\')`,
      );
    }
    const from = `FROM tokens t LEFT JOIN token_state s ON s.mint = t.mint LEFT JOIN smart_wallet_tokens w ON w.mint = t.mint LEFT JOIN token_cycles c ON c.mint = t.mint${
      where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""
    }`;
    if (forCount) return { sql: `SELECT COUNT(*) AS n ${from}`, params: params.values };

    const direction = query.sort.direction === "asc" ? "ASC" : "DESC";
    const sql = `
    SELECT t.*, COALESCE(s.status, 'pending') AS status_now, ${lifecycle()} AS lifecycle_now,
           s.max_score, s.holders, s.liquidity_sol, s.bonding_curve_pct, s.migrated,
           s.last_price_sol, s.peak_price_sol, s.last_trade_at,
           (SELECT COUNT(*) FROM token_snapshots x WHERE x.mint = t.mint) AS snapshot_count, ${SMART_SUMMARY_COLUMNS},
           ${CYCLE_LIST_COLUMNS}
    ${from}
    ORDER BY ${SORT_COLUMNS[query.sort.field]} ${direction} NULLS LAST, t.detected_at DESC, t.mint ASC
    LIMIT ${params.add(query.pageSize)} OFFSET ${params.add((query.page - 1) * query.pageSize)}`;
    return { sql, params: params.values };
  };
  return { list: build(false), count: build(true) };
};

const toStatus = (value: unknown): SafetyStatus =>
  value === "passed" || value === "failed" || value === "unverified" ? value : "pending";
const toLifecycle = (value: unknown): Lifecycle => (value === "dead" ? "dead" : "active");

export const toTokenListEntry = (row: Row): TokenListEntry => {
  const cycle = toListCycle(row);
  return { ...toTokenListEntryWithoutCycle(row), ...(cycle !== null && { cycle }) };
};

const toTokenListEntryWithoutCycle = (row: Row): TokenListEntry => ({
  token: toToken(row),
  status: toStatus(row["status_now"]),
  lifecycle: toLifecycle(row["lifecycle_now"]),
  liquidity: toLiquidity(row),
  lastPriceSol: numberOrNull(row["last_price_sol"]),
  peakPriceSol: numberOrNull(row["peak_price_sol"]),
  maxScore: numberOrNull(row["max_score"]),
  holders: numberOrNull(row["holders"]),
  lastTradeAt: toDateOrNull(row["last_trade_at"]),
  snapshotCount: Number(row["snapshot_count"] ?? 0),
  smartWallets: toSmartWalletsSummary(row),
});

/** Lifecycle of one token, or no row if it was never seen. */
export const tokenLifecycleStatement = (dialect: CatalogDialect, mint: string, now: Date): Statement => {
  const params = new Params(dialect);
  const lifecycle = lifecycleSql(params.add(deadBefore(now), "bigint"));
  return {
    sql: `SELECT ${lifecycle} AS lifecycle_now FROM tokens t LEFT JOIN token_state s ON s.mint = t.mint WHERE t.mint = ${params.add(mint)}`,
    params: params.values,
  };
};

export const lifecycleOf = (row: Row): Lifecycle => toLifecycle(row["lifecycle_now"]);

/** Parameter 1 = mint. Insertion order breaks ties between snapshots taken at the same time. */
export const tokenSnapshotsSql = ({ param }: ChartDialect): string =>
  `SELECT * FROM token_snapshots WHERE mint = ${param(1)} ORDER BY at ASC, id ASC`;

export const statsStatement = (dialect: CatalogDialect, now: Date): Statement => {
  const params = new Params(dialect);
  const lifecycle = lifecycleSql(params.add(deadBefore(now), "bigint"));
  const statusCount = (status: string) => `SUM(CASE WHEN COALESCE(s.status, 'pending') = '${status}' THEN 1 ELSE 0 END) AS ${status}`;
  return {
    sql: `
    SELECT COUNT(*) AS total, MIN(t.detected_at) AS since,
           SUM(CASE WHEN ${lifecycle} = 'dead' THEN 1 ELSE 0 END) AS dead,
           SUM(CASE WHEN s.migrated = 1 THEN 1 ELSE 0 END) AS migrated,
           ${["passed", "failed", "unverified", "pending"].map(statusCount).join(", ")},
           (SELECT COUNT(*) FROM trades) AS trades,
           (SELECT COUNT(*) FROM token_snapshots) AS snapshots
    FROM tokens t LEFT JOIN token_state s ON s.mint = t.mint`,
    params: params.values,
  };
};

export const toStats = (row: Row | undefined): HistoryStats => {
  const count = (key: string) => Number(row?.[key] ?? 0);
  const total = count("total");
  const dead = count("dead");
  return {
    since: toDateOrNull(row?.["since"]),
    tokens: { total, active: total - dead, dead, migrated: count("migrated") },
    screenings: {
      passed: count("passed"),
      failed: count("failed"),
      unverified: count("unverified"),
      pending: count("pending"),
    },
    trades: count("trades"),
    snapshots: count("snapshots"),
  };
};
