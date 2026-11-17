import type { ReputationStats } from "../../wallet-reputation/domain/closed-result.js";
import type { WalletRecord, WalletStyle, WalletTier } from "../../wallet-reputation/domain/reputation-rules.js";
import type { ObservedTrade } from "../../wallet-reputation/domain/wallet-positions.js";
import type {
  ClosableToken,
  SmartWalletEntry,
  StoredOutcome,
  StoredWalletResult,
  TokenClose,
  WalletBuy,
} from "../../wallet-reputation/domain/wallet-reputation-store.js";
import type { TokenOutcome } from "../../wallet-reputation/domain/smart-wallet-outcome.js";
import { Params, type CatalogDialect, type Statement } from "./catalog-sql.js";
import { numberOrNull, toDate, toDateOrNull, type ChartDialect, type Row, type SqlValue } from "./history-rows.js";

/**
 * SQL and row mapping of wallet results, reputations and smart wallets, shared by every adapter so
 * both engines answer identically. Only new tables: existing ones are read, never changed.
 */

export const walletReputationDdl = (types: { real: string; time: string }): string => `
CREATE TABLE IF NOT EXISTS token_closures (
  mint TEXT PRIMARY KEY,
  closed_at ${types.time} NOT NULL
);
CREATE TABLE IF NOT EXISTS wallet_token_results (
  wallet TEXT NOT NULL,
  mint TEXT NOT NULL,
  first_buy_at ${types.time} NOT NULL,
  entry_seconds ${types.real} NOT NULL,
  bought_sol ${types.real} NOT NULL,
  sold_sol ${types.real} NOT NULL,
  pnl_sol ${types.real} NOT NULL,
  closed_at ${types.time} NOT NULL,
  PRIMARY KEY (wallet, mint)
);
CREATE INDEX IF NOT EXISTS wallet_token_results_wallet_closed ON wallet_token_results (wallet, closed_at);
CREATE INDEX IF NOT EXISTS wallet_token_results_mint ON wallet_token_results (mint);
CREATE INDEX IF NOT EXISTS wallet_token_results_closed ON wallet_token_results (closed_at);
CREATE TABLE IF NOT EXISTS wallet_reputation (
  wallet TEXT PRIMARY KEY,
  tier TEXT NOT NULL,
  is_bot INTEGER NOT NULL,
  tokens INTEGER NOT NULL,
  wins INTEGER NOT NULL,
  win_rate ${types.real} NOT NULL,
  net_pnl_sol ${types.real} NOT NULL,
  avg_pnl_sol ${types.real} NOT NULL,
  median_entry_seconds ${types.real},
  last_active_at ${types.time},
  updated_at ${types.time} NOT NULL
);
CREATE INDEX IF NOT EXISTS wallet_reputation_tier ON wallet_reputation (tier);
CREATE INDEX IF NOT EXISTS wallet_reputation_updated ON wallet_reputation (updated_at);
CREATE TABLE IF NOT EXISTS token_smart_wallets (
  mint TEXT NOT NULL,
  wallet TEXT NOT NULL,
  tier_at_entry TEXT NOT NULL,
  first_buy_at ${types.time} NOT NULL,
  entry_seconds ${types.real} NOT NULL,
  bought_sol ${types.real} NOT NULL,
  sold_sol ${types.real} NOT NULL,
  still_holding INTEGER NOT NULL,
  PRIMARY KEY (mint, wallet)
);
CREATE INDEX IF NOT EXISTS token_smart_wallets_wallet ON token_smart_wallets (wallet);
CREATE TABLE IF NOT EXISTS smart_wallet_tokens (
  mint TEXT PRIMARY KEY,
  wallets INTEGER NOT NULL,
  elite INTEGER NOT NULL,
  holding INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS smart_wallet_tokens_wallets ON smart_wallet_tokens (wallets);
CREATE TABLE IF NOT EXISTS smart_wallet_outcomes (
  mint TEXT PRIMARY KEY,
  detected_at ${types.time} NOT NULL,
  closed_at ${types.time} NOT NULL,
  smart_wallets INTEGER NOT NULL,
  entry_at ${types.time} NOT NULL,
  entry_price_sol ${types.real} NOT NULL,
  return_pct ${types.real} NOT NULL,
  reached_2x INTEGER NOT NULL,
  peak_x ${types.real} NOT NULL
);
CREATE INDEX IF NOT EXISTS smart_wallet_outcomes_detected ON smart_wallet_outcomes (detected_at);
CREATE TABLE IF NOT EXISTS conviction_outcomes (
  mint TEXT PRIMARY KEY,
  detected_at ${types.time} NOT NULL,
  closed_at ${types.time} NOT NULL,
  conviction_wallets INTEGER NOT NULL,
  entry_at ${types.time} NOT NULL,
  entry_price_sol ${types.real} NOT NULL,
  return_pct ${types.real} NOT NULL,
  reached_2x INTEGER NOT NULL,
  peak_x ${types.real} NOT NULL
);
CREATE INDEX IF NOT EXISTS conviction_outcomes_detected ON conviction_outcomes (detected_at);
`;

/** A column added to a wallet-reputation table after it was first created. */
export interface AddedColumn {
  readonly table: string;
  readonly column: string;
  /** Column type and constraints, e.g. `INTEGER NOT NULL DEFAULT 0`. */
  readonly definition: string;
}

/**
 * Columns added for decision D7 (hold times and trading styles), applied idempotently by each
 * adapter after `walletReputationDdl` (only to these derived tables; raw tables are never altered).
 * Rows closed before them keep NULLs until their token is closed again at `CLOSE_VERSION`.
 */
export const walletReputationAddedColumns = (types: { real: string; time: string }): AddedColumn[] => [
  { table: "token_closures", column: "version", definition: "INTEGER" },
  { table: "wallet_token_results", column: "first_sell_at", definition: types.time },
  { table: "token_smart_wallets", column: "style_at_entry", definition: "TEXT" },
  { table: "smart_wallet_tokens", column: "conviction", definition: "INTEGER NOT NULL DEFAULT 0" },
  { table: "wallet_reputation", column: "style", definition: "TEXT" },
  { table: "wallet_reputation", column: "flip_rate", definition: types.real },
  { table: "wallet_reputation", column: "median_hold_seconds", definition: types.real },
];

/** Indexes on added columns, created once the columns exist. */
export const WALLET_REPUTATION_ADDED_INDEXES =
  "CREATE INDEX IF NOT EXISTS smart_wallet_tokens_conviction ON smart_wallet_tokens (conviction);";

/**
 * Version written with every token close. Version 2 (decision D7) adds hold times, styles at entry,
 * conviction counts and conviction outcomes; tokens closed before it are closed again.
 */
export const CLOSE_VERSION = 2;

/** Rows per multi-row INSERT, and values per IN list, well below both engines' parameter limits. */
export const ROWS_PER_STATEMENT = 100;
export const WALLETS_PER_QUERY = 400;

export const chunked = <T>(items: readonly T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) chunks.push(items.slice(start, start + size));
  return chunks;
};

const flag = (value: boolean): number => (value ? 1 : 0);

/** One multi-row INSERT per chunk of rows; `conflict` is appended to each. */
const insertRows = (
  dialect: CatalogDialect,
  table: string,
  columns: readonly string[],
  rows: readonly SqlValue[][],
  conflict: string,
): Statement[] =>
  chunked(rows, ROWS_PER_STATEMENT).map((chunk) => {
    const params = new Params(dialect);
    const values = chunk.map((row) => `(${row.map((value) => params.add(value)).join(", ")})`).join(", ");
    return { sql: `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${values} ${conflict}`, params: params.values };
  });

const updateAll = (columns: readonly string[]): string => columns.map((column) => `${column} = excluded.${column}`).join(", ");

/** Unclosed tokens detected in [from, upTo], oldest first. */
export const closableTokensStatement = (dialect: CatalogDialect, from: Date | null, upTo: Date, limit: number): Statement => {
  const params = new Params(dialect);
  const since = from === null ? "" : `t.detected_at >= ${params.add(from.getTime())} AND `;
  return {
    sql: `SELECT t.mint, t.creator, t.detected_at FROM tokens t
          WHERE ${since}t.detected_at <= ${params.add(upTo.getTime())}
            AND NOT EXISTS (SELECT 1 FROM token_closures c WHERE c.mint = t.mint AND c.version >= ${params.add(CLOSE_VERSION, "integer")})
          ORDER BY t.detected_at ASC, t.mint ASC LIMIT ${params.add(limit)}`,
    params: params.values,
  };
};

export const toClosableToken = (row: Row): ClosableToken => ({
  mint: String(row["mint"]),
  creator: String(row["creator"]),
  detectedAt: toDate(row["detected_at"]),
});

/** Parameter 1 = mint. */
export const tokenTradesSql = ({ param, sequence }: ChartDialect): string => `
  SELECT trader, side, sol_amount, token_amount, price_sol, timestamp FROM trades
  WHERE mint = ${param(1)} ORDER BY timestamp ASC, ${sequence} ASC`;

export const toObservedTrade = (row: Row): ObservedTrade => ({
  trader: String(row["trader"]),
  side: row["side"] === "sell" ? "sell" : "buy",
  solAmount: Number(row["sol_amount"]),
  tokenAmount: Number(row["token_amount"]),
  priceSol: Number(row["price_sol"]),
  timestamp: toDate(row["timestamp"]),
});

/** Parameter 1 = mint. */
export const firstScreeningSql = ({ param }: ChartDialect): string =>
  `SELECT MIN(evaluated_at) AS at FROM screenings WHERE mint = ${param(1)}`;

export const toFirstScreeningAt = (row: Row | undefined): Date | null => toDateOrNull(row?.["at"]);

/**
 * Stats of each wallet at its own buy time: results closed in [buy − lookback, buy), other than
 * the excluded mint, and how many of them were flipped (first sell at most `flipWindowMs` after
 * the first buy). Same rules as `statsAt` in the domain.
 */
export const statsAtBuysStatement = (
  dialect: CatalogDialect,
  buys: readonly WalletBuy[],
  lookbackMs: number,
  excludedMint: string,
  flipWindowMs: number,
): Statement => {
  const params = new Params(dialect);
  const values = buys
    .map(({ wallet, at }) => `(${params.add(wallet, "text")}, ${params.add(at.getTime(), "bigint")})`)
    .join(", ");
  const lookback = params.add(lookbackMs, "bigint");
  const mint = params.add(excludedMint, "text");
  const flipWindow = params.add(flipWindowMs, "bigint");
  return {
    sql: `WITH b (wallet, buy_at) AS (VALUES ${values})
          SELECT b.wallet AS wallet, COUNT(r.mint) AS tokens,
                 COALESCE(SUM(CASE WHEN r.pnl_sol > 0 THEN 1 ELSE 0 END), 0) AS wins,
                 COALESCE(SUM(r.pnl_sol), 0) AS net_pnl_sol,
                 COALESCE(SUM(CASE WHEN r.first_sell_at IS NOT NULL AND r.first_sell_at - r.first_buy_at <= ${flipWindow} THEN 1 ELSE 0 END), 0) AS flips
          FROM b JOIN wallet_token_results r
            ON r.wallet = b.wallet AND r.closed_at < b.buy_at AND r.closed_at >= b.buy_at - ${lookback} AND r.mint <> ${mint}
          GROUP BY b.wallet`,
    params: params.values,
  };
};

const round9 = (value: number): number => Math.round(value * 1e9) / 1e9;

export const toStatsEntry = (row: Row): [string, ReputationStats] => [
  String(row["wallet"]),
  {
    tokens: Number(row["tokens"]),
    wins: Number(row["wins"]),
    netPnlSol: round9(Number(row["net_pnl_sol"])),
    flips: Number(row["flips"]),
  },
];

const RESULT_COLUMNS = [
  "wallet",
  "mint",
  "first_buy_at",
  "entry_seconds",
  "bought_sol",
  "sold_sol",
  "pnl_sol",
  "closed_at",
  "first_sell_at",
];
const SMART_COLUMNS = [
  "mint",
  "wallet",
  "tier_at_entry",
  "first_buy_at",
  "entry_seconds",
  "bought_sol",
  "sold_sol",
  "still_holding",
  "style_at_entry",
];
/** Columns of `smart_wallet_outcomes`; `conviction_outcomes` names its count `conviction_wallets`. */
const outcomeColumns = (count: string): string[] => [
  "mint",
  "detected_at",
  "closed_at",
  count,
  "entry_at",
  "entry_price_sol",
  "return_pct",
  "reached_2x",
  "peak_x",
];

const smartWalletValues = (mint: string, entry: SmartWalletEntry): SqlValue[] => [
  mint,
  entry.wallet,
  entry.tierAtEntry,
  entry.firstBuyAt.getTime(),
  entry.entrySeconds,
  entry.boughtSol,
  entry.soldSol,
  flag(entry.stillHolding),
  entry.styleAtEntry,
];

/** Recounts a token's smart wallets into its summary row. */
const smartSummaryStatement = (dialect: CatalogDialect, mint: string): Statement => {
  const params = new Params(dialect);
  const value = params.add(mint, "text");
  return {
    sql: `INSERT INTO smart_wallet_tokens (mint, wallets, elite, holding, conviction)
          SELECT ${value}, COUNT(*), COALESCE(SUM(CASE WHEN tier_at_entry = 'elite' THEN 1 ELSE 0 END), 0),
                 COALESCE(SUM(still_holding), 0),
                 COALESCE(SUM(CASE WHEN style_at_entry = 'conviction' THEN 1 ELSE 0 END), 0)
          FROM token_smart_wallets WHERE mint = ${value}
          ON CONFLICT (mint) DO UPDATE SET wallets = excluded.wallets, elite = excluded.elite, holding = excluded.holding,
                                           conviction = excluded.conviction`,
    params: params.values,
  };
};

export const saveSmartWalletStatements = (dialect: CatalogDialect, mint: string, entry: SmartWalletEntry): Statement[] => [
  ...insertRows(dialect, "token_smart_wallets", SMART_COLUMNS, [smartWalletValues(mint, entry)], `ON CONFLICT (mint, wallet) DO UPDATE SET ${updateAll(SMART_COLUMNS.slice(2))}`),
  smartSummaryStatement(dialect, mint),
];

/** Statements that store a token's close, to run in one transaction. Running them again changes nothing. */
export const saveTokenCloseStatements = (dialect: CatalogDialect, close: TokenClose): Statement[] => {
  const p = dialect.param;
  const { mint } = close;
  const results = close.results.map((result): SqlValue[] => [
    result.wallet,
    mint,
    result.firstBuyAt.getTime(),
    result.entrySeconds,
    result.boughtSol,
    result.soldSol,
    result.pnlSol,
    result.closedAt.getTime(),
    result.firstSellAt?.getTime() ?? null,
  ]);
  const outcomeRows = (outcome: TokenOutcome | null | undefined): SqlValue[][] =>
    outcome === null || outcome === undefined
      ? []
      : [
          [
            mint,
            close.detectedAt.getTime(),
            close.closedAt.getTime(),
            outcome.smartWallets,
            outcome.entryAt.getTime(),
            outcome.entryPriceSol,
            outcome.returnPct,
            flag(outcome.reached2x),
            outcome.peakX,
          ],
        ];
  return [
    ...insertRows(dialect, "wallet_token_results", RESULT_COLUMNS, results, `ON CONFLICT (wallet, mint) DO UPDATE SET ${updateAll(RESULT_COLUMNS.slice(2))}`),
    { sql: `DELETE FROM token_smart_wallets WHERE mint = ${p(1)}`, params: [mint] },
    ...insertRows(dialect, "token_smart_wallets", SMART_COLUMNS, close.smartWallets.map((entry) => smartWalletValues(mint, entry)), ""),
    smartSummaryStatement(dialect, mint),
    { sql: `DELETE FROM smart_wallet_outcomes WHERE mint = ${p(1)}`, params: [mint] },
    ...insertRows(dialect, "smart_wallet_outcomes", outcomeColumns("smart_wallets"), outcomeRows(close.outcome), ""),
    { sql: `DELETE FROM conviction_outcomes WHERE mint = ${p(1)}`, params: [mint] },
    ...insertRows(dialect, "conviction_outcomes", outcomeColumns("conviction_wallets"), outcomeRows(close.convictionOutcome), ""),
    ...insertRows(
      dialect,
      "token_closures",
      ["mint", "closed_at", "version"],
      [[mint, close.closedAt.getTime(), CLOSE_VERSION]],
      "ON CONFLICT (mint) DO UPDATE SET closed_at = excluded.closed_at, version = excluded.version",
    ),
  ];
};

/** Results of the wallets closed at or after `since`, newest first buy first. */
export const walletResultsStatement = (dialect: CatalogDialect, wallets: readonly string[], since: Date): Statement => {
  const params = new Params(dialect);
  const list = wallets.map((wallet) => params.add(wallet)).join(", ");
  return {
    sql: `SELECT r.*, t.symbol, t.name FROM wallet_token_results r LEFT JOIN tokens t ON t.mint = r.mint
          WHERE r.wallet IN (${list}) AND r.closed_at >= ${params.add(since.getTime())}
          ORDER BY r.first_buy_at DESC, r.mint ASC, r.wallet ASC`,
    params: params.values,
  };
};

export const toStoredWalletResult = (row: Row): StoredWalletResult => ({
  wallet: String(row["wallet"]),
  mint: String(row["mint"]),
  symbol: String(row["symbol"] ?? ""),
  name: String(row["name"] ?? ""),
  firstBuyAt: toDate(row["first_buy_at"]),
  firstSellAt: toDateOrNull(row["first_sell_at"]),
  entrySeconds: Number(row["entry_seconds"]),
  boughtSol: Number(row["bought_sol"]),
  soldSol: Number(row["sold_sol"]),
  pnlSol: Number(row["pnl_sol"]),
  closedAt: toDate(row["closed_at"]),
});

/** Order of `walletResultsStatement`, kept when the results of several chunks are merged. */
export const newestFirstBuy = (a: StoredWalletResult, b: StoredWalletResult): number =>
  b.firstBuyAt.getTime() - a.firstBuyAt.getTime() || (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0) || (a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0);

/** Parameter 1 = wallet. */
export const hasWalletResultsSql = ({ param }: ChartDialect): string =>
  `SELECT 1 AS found FROM wallet_token_results WHERE wallet = ${param(1)} LIMIT 1`;

const RECORD_COLUMNS = [
  "wallet",
  "tier",
  "is_bot",
  "tokens",
  "wins",
  "win_rate",
  "net_pnl_sol",
  "avg_pnl_sol",
  "median_entry_seconds",
  "last_active_at",
  "updated_at",
  "style",
  "flip_rate",
  "median_hold_seconds",
];

export const saveWalletRecordsStatements = (dialect: CatalogDialect, records: readonly WalletRecord[]): Statement[] =>
  insertRows(
    dialect,
    "wallet_reputation",
    RECORD_COLUMNS,
    records.map((record) => [
      record.address,
      record.tier,
      flag(record.isBot),
      record.tokens,
      record.wins,
      record.winRate,
      record.netPnlSol,
      record.avgPnlSol,
      record.medianEntrySeconds,
      record.lastActiveAt?.getTime() ?? null,
      record.updatedAt.getTime(),
      record.style,
      record.flipRate,
      record.medianHoldSeconds,
    ]),
    `ON CONFLICT (wallet) DO UPDATE SET ${updateAll(RECORD_COLUMNS.slice(1))}`,
  );

const toTier = (value: unknown): WalletTier => (value === "elite" || value === "good" ? value : "none");

/** Rows written before decision D7 have no style yet: unrated until their token or record is recomputed. */
const toStyle = (value: unknown): WalletStyle =>
  value === "conviction" || value === "flipper" || value === "mixed" ? value : "unrated";

export const toWalletRecord = (row: Row): WalletRecord => ({
  address: String(row["wallet"]),
  tier: toTier(row["tier"]),
  isBot: Number(row["is_bot"]) === 1,
  tokens: Number(row["tokens"]),
  wins: Number(row["wins"]),
  winRate: Number(row["win_rate"]),
  netPnlSol: Number(row["net_pnl_sol"]),
  avgPnlSol: Number(row["avg_pnl_sol"]),
  medianEntrySeconds: numberOrNull(row["median_entry_seconds"]),
  style: toStyle(row["style"]),
  flipRate: numberOrNull(row["flip_rate"]),
  medianHoldSeconds: numberOrNull(row["median_hold_seconds"]),
  lastActiveAt: toDateOrNull(row["last_active_at"]),
  updatedAt: toDate(row["updated_at"]),
});

export const staleWalletsStatement = (dialect: CatalogDialect, updatedBefore: Date, limit: number): Statement => ({
  sql: `SELECT wallet FROM wallet_reputation WHERE updated_at < ${dialect.param(1)} AND tokens > 0
        ORDER BY updated_at ASC, wallet ASC LIMIT ${dialect.param(2)}`,
  params: [updatedBefore.getTime(), limit],
});

export const smartWalletRecordsStatement = (dialect: CatalogDialect, limit: number): Statement => ({
  sql: `SELECT * FROM wallet_reputation WHERE tier IN ('good', 'elite')
        ORDER BY net_pnl_sol DESC, wallet ASC LIMIT ${dialect.param(1)}`,
  params: [limit],
});

/** Parameter 1 = mint. */
export const tokenSmartWalletsSql = ({ param }: ChartDialect): string =>
  `SELECT * FROM token_smart_wallets WHERE mint = ${param(1)} ORDER BY first_buy_at ASC, wallet ASC`;

/** Parameter 1 = mint. */
export const tokenSmartSummarySql = ({ param }: ChartDialect): string =>
  `SELECT wallets AS sw_count, elite AS sw_elite, holding AS sw_holding, conviction AS sw_conviction
   FROM smart_wallet_tokens WHERE mint = ${param(1)}`;

export const mintsWithSmartWalletsStatement = (dialect: CatalogDialect, mints: readonly string[], minSmartWallets: number): Statement => {
  const params = new Params(dialect);
  const list = mints.map((mint) => params.add(mint)).join(", ");
  return {
    sql: `SELECT mint FROM smart_wallet_tokens WHERE wallets >= ${params.add(minSmartWallets, "integer")} AND mint IN (${list})`,
    params: params.values,
  };
};

export const mintsWithConvictionWalletsStatement = (
  dialect: CatalogDialect,
  mints: readonly string[],
  minConvictionWallets: number,
): Statement => {
  const params = new Params(dialect);
  const list = mints.map((mint) => params.add(mint)).join(", ");
  return {
    sql: `SELECT mint FROM smart_wallet_tokens WHERE conviction >= ${params.add(minConvictionWallets, "integer")} AND mint IN (${list})`,
    params: params.values,
  };
};

export const toSmartWalletEntry = (row: Row): SmartWalletEntry => ({
  wallet: String(row["wallet"]),
  tierAtEntry: row["tier_at_entry"] === "elite" ? "elite" : "good",
  styleAtEntry: toStyle(row["style_at_entry"]),
  firstBuyAt: toDate(row["first_buy_at"]),
  entrySeconds: Number(row["entry_seconds"]),
  boughtSol: Number(row["bought_sol"]),
  soldSol: Number(row["sold_sol"]),
  stillHolding: Number(row["still_holding"]) === 1,
});

export const smartWalletOutcomesStatement = (dialect: CatalogDialect, from: Date, to: Date): Statement => ({
  sql: `SELECT o.smart_wallets, o.return_pct, o.reached_2x, o.peak_x, COALESCE(s.migrated, 0) AS migrated
        FROM smart_wallet_outcomes o LEFT JOIN token_state s ON s.mint = o.mint
        WHERE o.detected_at >= ${dialect.param(1)} AND o.detected_at < ${dialect.param(2)}
        ORDER BY o.detected_at ASC, o.mint ASC`,
  params: [from.getTime(), to.getTime()],
});

export const convictionOutcomesStatement = (dialect: CatalogDialect, from: Date, to: Date): Statement => ({
  sql: `SELECT o.conviction_wallets AS smart_wallets, o.return_pct, o.reached_2x, o.peak_x, COALESCE(s.migrated, 0) AS migrated
        FROM conviction_outcomes o LEFT JOIN token_state s ON s.mint = o.mint
        WHERE o.detected_at >= ${dialect.param(1)} AND o.detected_at < ${dialect.param(2)}
        ORDER BY o.detected_at ASC, o.mint ASC`,
  params: [from.getTime(), to.getTime()],
});

export const toStoredOutcome = (row: Row): StoredOutcome => ({
  smartWallets: Number(row["smart_wallets"]),
  returnPct: Number(row["return_pct"]),
  reached2x: Number(row["reached_2x"]) === 1,
  peakX: Number(row["peak_x"]),
  migrated: Number(row["migrated"]) === 1,
});
