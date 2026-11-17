import type { CycleSample } from "../../token-cycle/domain/cycle-analysis.js";
import {
  summarizeCycle,
  tradePoints,
  type CycleState,
  type SnapshotPoint,
  type TradeCursor,
  type TradePoint,
} from "../../token-cycle/domain/token-cycle.js";
import type { CycleBacklogCursor, CycleToken, FollowedCycle } from "../../token-cycle/domain/token-cycle-store.js";
import type { CYCLE_COLUMNS } from "./token-cycle-rows.js";
import { Params, type CatalogDialect, type Statement } from "./catalog-sql.js";
import { numberOrNull, toDate, toDateOrNull, type ChartDialect, type Row, type SqlValue } from "./history-rows.js";

/**
 * SQL and row mapping of token cycles (`token_cycles`, one row per public token), shared by every
 * adapter so both engines answer identically. A new derived table: existing ones are only read.
 */

export const tokenCyclesDdl = (types: { real: string; time: string }): string => `
CREATE TABLE IF NOT EXISTS token_cycles (
  mint TEXT PRIMARY KEY,
  appeared_at ${types.time} NOT NULL,
  launch_price_sol ${types.real},
  appeared_price_sol ${types.real},
  late_at ${types.time},
  appeared_late INTEGER NOT NULL DEFAULT 0,
  phase TEXT NOT NULL DEFAULT 'stable',
  calm_at ${types.time},
  run_start_at ${types.time},
  explosion_at ${types.time},
  invest_window_seconds ${types.real},
  peak_at ${types.time},
  peak_price_sol ${types.real},
  peak_x ${types.real},
  crash_at ${types.time},
  max_drawdown_pct ${types.real},
  last_price_sol ${types.real},
  trade_cursor_at ${types.time},
  trade_cursor_count INTEGER NOT NULL DEFAULT 0,
  snapshot_cursor_at ${types.time},
  caught_up INTEGER NOT NULL DEFAULT 0,
  updated_at ${types.time} NOT NULL
);
CREATE INDEX IF NOT EXISTS token_cycles_appeared ON token_cycles (appeared_at);
CREATE INDEX IF NOT EXISTS token_cycles_window ON token_cycles (invest_window_seconds);
CREATE INDEX IF NOT EXISTS token_cycles_pending ON token_cycles (mint) WHERE caught_up = 0;
`;

const time = (date: Date | null): number | null => date?.getTime() ?? null;

/** Parameter 1 = mint. */
export const cycleTokenSql = ({ param }: ChartDialect): string => `SELECT mint, creator, detected_at FROM tokens WHERE mint = ${param(1)}`;

export const toCycleToken = (row: Row): CycleToken => ({
  mint: String(row["mint"]),
  creator: String(row["creator"]),
  detectedAt: toDate(row["detected_at"]),
});

/** First buy of the k-th conviction wallet of a token, by first buy then wallet. */
export const appearanceAtStatement = (dialect: CatalogDialect, mint: string, minConvictionWallets: number): Statement => {
  const params = new Params(dialect);
  return {
    sql: `SELECT first_buy_at FROM token_smart_wallets
          WHERE mint = ${params.add(mint)} AND style_at_entry = 'conviction'
          ORDER BY first_buy_at ASC, wallet ASC LIMIT 1 OFFSET ${params.add(Math.max(0, minConvictionWallets - 1), "bigint")}`,
    params: params.values,
  };
};

/** Inserts an empty cycle; a token that already has one keeps it untouched and returns no row. */
export const createCycleStatement = (dialect: CatalogDialect, mint: string, appearedAt: Date, now: Date): Statement => {
  const params = new Params(dialect);
  return {
    sql: `INSERT INTO token_cycles (mint, appeared_at, updated_at)
          VALUES (${params.add(mint)}, ${params.add(appearedAt.getTime())}, ${params.add(now.getTime())})
          ON CONFLICT (mint) DO NOTHING RETURNING mint`,
    params: params.values,
  };
};

/** Parameter 1 = mint. */
export const tokenCycleSql = ({ param }: ChartDialect): string => `SELECT * FROM token_cycles WHERE mint = ${param(1)}`;

/** Updates everything but `mint` and `appeared_at`, which are written once. */
export const saveCycleStatement = (dialect: CatalogDialect, mint: string, state: CycleState, caughtUp: boolean, updatedAt: Date): Statement => {
  const summary = summarizeCycle(state, updatedAt);
  const values: Readonly<Record<Exclude<(typeof CYCLE_COLUMNS)[number], "appeared_at">, SqlValue>> = {
    launch_price_sol: state.launchPriceSol,
    appeared_price_sol: state.appearedPriceSol,
    late_at: time(state.lateAt),
    appeared_late: summary.appearedLate ? 1 : 0,
    phase: state.phase,
    calm_at: time(state.calmAt),
    run_start_at: time(state.runStartAt),
    explosion_at: time(state.explosionAt),
    invest_window_seconds: summary.investWindowSeconds,
    peak_at: time(state.peakAt),
    peak_price_sol: state.peakPriceSol,
    peak_x: summary.peakX,
    crash_at: time(state.crashAt),
    max_drawdown_pct: state.maxDrawdownPct,
    last_price_sol: state.lastPriceSol,
    trade_cursor_at: time(state.tradeCursor?.at ?? null),
    trade_cursor_count: state.tradeCursor?.count ?? 0,
    snapshot_cursor_at: time(state.snapshotCursorAt),
    caught_up: caughtUp ? 1 : 0,
    updated_at: updatedAt.getTime(),
  };
  const params = new Params(dialect);
  const sets = Object.entries(values).map(([column, value]) => `${column} = ${params.add(value)}`);
  return { sql: `UPDATE token_cycles SET ${sets.join(", ")} WHERE mint = ${params.add(mint)}`, params: params.values };
};

/**
 * Trades after the cursor: those of its timestamp past the ones already folded, then every later
 * one. Insertion order breaks ties, so a trade stored later with the cursor's timestamp comes last.
 */
export const cycleTradesStatement = (dialect: CatalogDialect, mint: string, after: TradeCursor | null, limit: number): Statement => {
  const params = new Params(dialect);
  return {
    sql: `SELECT price_sol, timestamp FROM trades
          WHERE mint = ${params.add(mint)} AND timestamp >= ${params.add(after?.at.getTime() ?? 0)}
          ORDER BY timestamp ASC, ${dialect.sequence} ASC
          LIMIT ${params.add(limit, "bigint")} OFFSET ${params.add(after?.count ?? 0, "bigint")}`,
    params: params.values,
  };
};

export const toTradePoints = (rows: readonly Row[], after: TradeCursor | null): TradePoint[] =>
  tradePoints(
    rows.map((row) => ({ at: toDate(row["timestamp"]), priceSol: Number(row["price_sol"]) })),
    after,
  );

export const cycleSnapshotsStatement = (dialect: CatalogDialect, mint: string, after: Date | null, limit: number): Statement => {
  const params = new Params(dialect);
  return {
    sql: `SELECT at, price_sol FROM token_snapshots
          WHERE mint = ${params.add(mint)} AND at > ${params.add(after?.getTime() ?? -1)} AND price_sol > 0
          ORDER BY at ASC, id ASC LIMIT ${params.add(limit, "bigint")}`,
    params: params.values,
  };
};

/** One price per moment: the first snapshot stored for it. */
export const toSnapshotPoints = (rows: readonly Row[]): SnapshotPoint[] => {
  const points: SnapshotPoint[] = [];
  for (const row of rows) {
    const at = toDate(row["at"]);
    if (points.at(-1)?.at.getTime() === at.getTime()) continue;
    points.push({ kind: "snapshot", at, priceSol: Number(row["price_sol"]) });
  }
  return points;
};

export const tokensMissingCycleStatement = (
  dialect: CatalogDialect,
  minConvictionWallets: number,
  before: CycleBacklogCursor | null,
  limit: number,
): Statement => {
  const params = new Params(dialect);
  const minimum = params.add(minConvictionWallets, "integer");
  let page = "";
  if (before !== null) {
    const detectedAt = params.add(before.detectedAt.getTime(), "bigint");
    page = ` AND (t.detected_at < ${detectedAt} OR (t.detected_at = ${detectedAt} AND t.mint > ${params.add(before.mint)}))`;
  }
  return {
    sql: `SELECT t.mint, t.creator, t.detected_at
          FROM smart_wallet_tokens w JOIN tokens t ON t.mint = w.mint LEFT JOIN token_cycles c ON c.mint = w.mint
          WHERE w.conviction >= ${minimum} AND (c.mint IS NULL OR c.caught_up = 0)${page}
          ORDER BY t.detected_at DESC, t.mint ASC LIMIT ${params.add(limit, "bigint")}`,
    params: params.values,
  };
};

export const recentCyclesStatement = (dialect: CatalogDialect, detectedAfter: Date, limit: number): Statement => {
  const params = new Params(dialect);
  return {
    sql: `SELECT c.mint, c.appeared_at, t.creator, t.detected_at
          FROM token_cycles c JOIN tokens t ON t.mint = c.mint
          WHERE t.detected_at > ${params.add(detectedAfter.getTime())}
          ORDER BY c.appeared_at DESC, c.mint ASC LIMIT ${params.add(limit, "bigint")}`,
    params: params.values,
  };
};

export const toFollowedCycle = (row: Row): FollowedCycle => ({ ...toCycleToken(row), appearedAt: toDate(row["appeared_at"]) });

export const cycleSamplesStatement = (dialect: CatalogDialect, from: Date, to: Date): Statement => {
  const params = new Params(dialect);
  return {
    sql: `SELECT appeared_at, appeared_late, explosion_at, invest_window_seconds, peak_at, peak_x, crash_at
          FROM token_cycles
          WHERE appeared_at >= ${params.add(from.getTime())} AND appeared_at < ${params.add(to.getTime())}
          ORDER BY appeared_at ASC, mint ASC`,
    params: params.values,
  };
};

export const toCycleSample = (row: Row): CycleSample => ({
  appearedAt: toDate(row["appeared_at"]),
  appearedLate: Number(row["appeared_late"] ?? 0) === 1,
  explosionAt: toDateOrNull(row["explosion_at"]),
  investWindowSeconds: numberOrNull(row["invest_window_seconds"]),
  peakAt: toDateOrNull(row["peak_at"]),
  peakX: numberOrNull(row["peak_x"]),
  crashAt: toDateOrNull(row["crash_at"]),
});
