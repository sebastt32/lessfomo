import {
  CYCLE_PHASES,
  summarizeCycle,
  type CyclePhase,
  type CycleState,
  type TokenCycle,
} from "../../token-cycle/domain/token-cycle.js";
import type { StoredCycle } from "../../token-cycle/domain/token-cycle-store.js";

/**
 * Columns and row mapping of `token_cycles`, also joined into token lists and screenings. It
 * imports nothing from the other row modules, which use it.
 */
type Row = Record<string, unknown>;

const numberOrNull = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
const toDate = (value: unknown): Date => new Date(Number(value));
const toDateOrNull = (value: unknown): Date | null => (value === null || value === undefined ? null : toDate(value));

/** Every column but `mint`, in table order. */
export const CYCLE_COLUMNS = [
  "appeared_at",
  "launch_price_sol",
  "appeared_price_sol",
  "late_at",
  "appeared_late",
  "phase",
  "calm_at",
  "run_start_at",
  "explosion_at",
  "invest_window_seconds",
  "peak_at",
  "peak_price_sol",
  "peak_x",
  "crash_at",
  "max_drawdown_pct",
  "last_price_sol",
  "trade_cursor_at",
  "trade_cursor_count",
  "snapshot_cursor_at",
  "caught_up",
  "updated_at",
] as const;

/** Prefix of the cycle columns joined into token lists and screenings (alias `c`). */
const LIST_PREFIX = "cy_";

/** Cycle columns of the joined `token_cycles c`, prefixed so they never shadow the token's own. */
export const CYCLE_LIST_COLUMNS = CYCLE_COLUMNS.map((column) => `c.${column} AS ${LIST_PREFIX}${column}`).join(", ");

const toPhase = (value: unknown): CyclePhase => CYCLE_PHASES.find((phase) => phase === value) ?? "stable";

const toCycleState = (row: Row, prefix: string): CycleState => {
  const cursorAt = toDateOrNull(row[`${prefix}trade_cursor_at`]);
  return {
    appearedAt: toDate(row[`${prefix}appeared_at`]),
    launchPriceSol: numberOrNull(row[`${prefix}launch_price_sol`]),
    appearedPriceSol: numberOrNull(row[`${prefix}appeared_price_sol`]),
    lateAt: toDateOrNull(row[`${prefix}late_at`]),
    phase: toPhase(row[`${prefix}phase`]),
    calmAt: toDateOrNull(row[`${prefix}calm_at`]),
    runStartAt: toDateOrNull(row[`${prefix}run_start_at`]),
    explosionAt: toDateOrNull(row[`${prefix}explosion_at`]),
    peakAt: toDateOrNull(row[`${prefix}peak_at`]),
    peakPriceSol: numberOrNull(row[`${prefix}peak_price_sol`]),
    crashAt: toDateOrNull(row[`${prefix}crash_at`]),
    maxDrawdownPct: numberOrNull(row[`${prefix}max_drawdown_pct`]),
    lastPriceSol: numberOrNull(row[`${prefix}last_price_sol`]),
    tradeCursor: cursorAt === null ? null : { at: cursorAt, count: Number(row[`${prefix}trade_cursor_count`] ?? 0) },
    snapshotCursorAt: toDateOrNull(row[`${prefix}snapshot_cursor_at`]),
  };
};

export const toStoredCycle = (row: Row): StoredCycle => ({
  state: toCycleState(row, ""),
  caughtUp: Number(row["caught_up"] ?? 0) === 1,
  updatedAt: toDate(row["updated_at"]),
});

/** The cycle joined into a token list row, or null when the token has none. */
export const toListCycle = (row: Row): TokenCycle | null => {
  if (row[`${LIST_PREFIX}appeared_at`] === null || row[`${LIST_PREFIX}appeared_at`] === undefined) return null;
  return summarizeCycle(toCycleState(row, LIST_PREFIX), toDate(row[`${LIST_PREFIX}updated_at`]));
};
