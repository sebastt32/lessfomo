/**
 * The cycle of a public token (decision D1): stable after appearing in the platform, explosion,
 * peak, crash. A pure state machine folded over the token's prices in time order: every field
 * comes only from the points folded so far, so nothing ever depends on later data.
 */

export type CyclePhase = "stable" | "exploding" | "crashed";

export const CYCLE_PHASES: readonly CyclePhase[] = ["stable", "exploding", "crashed"];

export interface CycleRules {
  /** The token explodes at the first trade after appearing whose price is at least this many times the base. */
  readonly explosionMultiple: number;
  /** The run-up starts at the last trade before the explosion priced at most this many times the base. */
  readonly runStartMultiple: number;
  /** The token crashes at the first trade after its peak priced at most this fraction of the peak. */
  readonly crashFraction: number;
  /** It appeared late when, before appearing, the price had reached this many times the launch price. */
  readonly lateMultiple: number;
  /** A snapshot price only counts when the token had no stored trade for this long before it. */
  readonly snapshotQuietMs: number;
}

export const DEFAULT_CYCLE_RULES: CycleRules = {
  explosionMultiple: 2,
  runStartMultiple: 1.2,
  crashFraction: 0.5,
  lateMultiple: 2,
  snapshotQuietMs: 120_000,
};

/** The price right after a stored trade. `ordinal` is its position among the token's trades of the same timestamp. */
export interface TradePoint {
  readonly kind: "trade";
  readonly at: Date;
  readonly priceSol: number;
  readonly ordinal: number;
}

/** The price of a stored snapshot: coarser, used once trade-by-trade data stopped. */
export interface SnapshotPoint {
  readonly kind: "snapshot";
  readonly at: Date;
  readonly priceSol: number;
}

export type CyclePoint = TradePoint | SnapshotPoint;

/** The last trade folded: trades before it, or with a lower ordinal in its timestamp, are never folded again. */
export interface TradeCursor {
  readonly at: Date;
  /** Trades folded with that timestamp. */
  readonly count: number;
}

export interface CycleState {
  /** When the token became public; never changes. */
  readonly appearedAt: Date;
  /** Price of the first trade seen. */
  readonly launchPriceSol: number | null;
  /** Base price: the last trade at or before `appearedAt`. */
  readonly appearedPriceSol: number | null;
  /** First trade at or before `appearedAt` priced at least `lateMultiple` × launch; null when it appeared in time. */
  readonly lateAt: Date | null;
  readonly phase: CyclePhase;
  /** Last calm trade (at most `runStartMultiple` × base) after appearing, while stable. */
  readonly calmAt: Date | null;
  readonly runStartAt: Date | null;
  readonly explosionAt: Date | null;
  readonly peakAt: Date | null;
  readonly peakPriceSol: number | null;
  readonly crashAt: Date | null;
  /** 0-100, deepest fall from the peak so far. */
  readonly maxDrawdownPct: number | null;
  readonly lastPriceSol: number | null;
  readonly tradeCursor: TradeCursor | null;
  /** Time of the last snapshot looked at. */
  readonly snapshotCursorAt: Date | null;
}

/** The cycle of a token that just appeared, before any price is folded. */
export const startCycle = (appearedAt: Date): CycleState => ({
  appearedAt,
  launchPriceSol: null,
  appearedPriceSol: null,
  lateAt: null,
  phase: "stable",
  calmAt: null,
  runStartAt: null,
  explosionAt: null,
  peakAt: null,
  peakPriceSol: null,
  crashAt: null,
  maxDrawdownPct: null,
  lastPriceSol: null,
  tradeCursor: null,
  snapshotCursorAt: null,
});

/** Numbers ordered trades (oldest first, insertion order inside a timestamp) as trade points. */
export const tradePoints = (trades: readonly { readonly at: Date; readonly priceSol: number }[], after: TradeCursor | null = null): TradePoint[] => {
  let at = after?.at.getTime() ?? null;
  let ordinal = after?.count ?? 0;
  return trades.map((trade) => {
    const time = trade.at.getTime();
    if (time !== at) {
      at = time;
      ordinal = 0;
    }
    return { kind: "trade", at: trade.at, priceSol: trade.priceSol, ordinal: ordinal++ };
  });
};

const drawdownPct = (peak: number, price: number): number => Math.max(0, (1 - price / peak) * 100);

/** The cycle after one more price. A price at or before the appearance only sets the launch and base prices. */
const foldPrice = (state: CycleState, at: Date, price: number, rules: CycleRules): CycleState => {
  if (at.getTime() <= state.appearedAt.getTime()) {
    const launch = state.launchPriceSol ?? price;
    const lateAt = state.lateAt ?? (price >= rules.lateMultiple * launch ? at : null);
    return { ...state, launchPriceSol: launch, appearedPriceSol: price, lateAt, lastPriceSol: price };
  }

  // Without a stored trade before the appearance, the first one seen is both launch and base.
  const base = state.appearedPriceSol ?? price;
  const seen: CycleState = { ...state, launchPriceSol: state.launchPriceSol ?? price, appearedPriceSol: base, lastPriceSol: price };

  if (state.phase === "stable") {
    if (price >= rules.explosionMultiple * base) {
      return {
        ...seen,
        phase: "exploding",
        explosionAt: at,
        runStartAt: state.calmAt ?? state.appearedAt,
        peakAt: at,
        peakPriceSol: price,
        maxDrawdownPct: 0,
      };
    }
    return price <= rules.runStartMultiple * base ? { ...seen, calmAt: at } : seen;
  }

  const peak = state.peakPriceSol ?? price;
  if (state.phase === "exploding" && price > peak) return { ...seen, peakAt: at, peakPriceSol: price };
  const fallen: CycleState = { ...seen, maxDrawdownPct: Math.max(state.maxDrawdownPct ?? 0, drawdownPct(peak, price)) };
  // Once crashed the cycle is complete: its peak and crash stay; only the last price and the drawdown move.
  return state.phase === "exploding" && price <= rules.crashFraction * peak ? { ...fallen, phase: "crashed", crashAt: at } : fallen;
};

const foldTrade = (state: CycleState, point: TradePoint, rules: CycleRules): CycleState => {
  const cursor = state.tradeCursor;
  const time = point.at.getTime();
  if (cursor !== null) {
    const cursorTime = cursor.at.getTime();
    if (time < cursorTime || (time === cursorTime && point.ordinal < cursor.count)) return state;
  }
  const count = cursor !== null && cursor.at.getTime() === time ? Math.max(cursor.count, point.ordinal) + 1 : point.ordinal + 1;
  const folded = point.priceSol > 0 ? foldPrice(state, point.at, point.priceSol, rules) : state;
  return { ...folded, tradeCursor: { at: point.at, count } };
};

const foldSnapshot = (state: CycleState, point: SnapshotPoint, rules: CycleRules): CycleState => {
  const time = point.at.getTime();
  if (state.snapshotCursorAt !== null && time <= state.snapshotCursorAt.getTime()) return state;
  const looked: CycleState = { ...state, snapshotCursorAt: point.at };
  const lastTradeAt = state.tradeCursor?.at.getTime() ?? null;
  const tradesFlowing = lastTradeAt !== null && time - lastTradeAt <= rules.snapshotQuietMs;
  if (time <= state.appearedAt.getTime() || tradesFlowing || !(point.priceSol > 0)) return looked;
  return foldPrice(looked, point.at, point.priceSol, rules);
};

/**
 * Folds `points` (oldest first) into the cycle. Points already folded are skipped (trades by the
 * trade cursor, snapshots by their time), so feeding the same points again changes nothing and the
 * same state object is returned.
 */
export const advanceCycle = (state: CycleState, points: readonly CyclePoint[], rules: CycleRules): CycleState =>
  points.reduce((current, point) => (point.kind === "trade" ? foldTrade(current, point, rules) : foldSnapshot(current, point, rules)), state);

/** What the API shows of a cycle (docs/API.md "Token cycle"). */
export interface TokenCycle {
  readonly appearedAt: Date;
  readonly launchPriceSol: number | null;
  readonly appearedPriceSol: number | null;
  /** appearedPriceSol / launchPriceSol. */
  readonly riseBeforeAppearanceX: number | null;
  readonly appearedLate: boolean;
  readonly phase: CyclePhase;
  readonly runStartAt: Date | null;
  readonly explosionAt: Date | null;
  /** runStartAt − appearedAt once exploded; negative (seconds between the earlier 2× and appearing) when late. */
  readonly investWindowSeconds: number | null;
  readonly peakAt: Date | null;
  /** Peak price / base price. */
  readonly peakX: number | null;
  readonly crashAt: Date | null;
  readonly maxDrawdownPct: number | null;
  /** Last price / base price. */
  readonly lastPriceX: number | null;
  readonly updatedAt: Date;
}

const round4 = (value: number): number => Math.round(value * 1e4) / 1e4;
const round2 = (value: number): number => Math.round(value * 100) / 100;

const ratio = (value: number | null, base: number | null): number | null =>
  value === null || base === null || !(base > 0) ? null : round4(value / base);

/** Seconds from `from` to `to`, to the millisecond. */
const secondsBetween = (from: Date, to: Date): number => (to.getTime() - from.getTime()) / 1000;

/** Time available to invest: negative for a late token, null while stable and in time. */
export const investWindowSeconds = (state: CycleState): number | null => {
  // `|| 0` keeps a zero window from being -0.
  if (state.lateAt !== null) return -secondsBetween(state.lateAt, state.appearedAt) || 0;
  return state.runStartAt === null ? null : secondsBetween(state.appearedAt, state.runStartAt);
};

export const summarizeCycle = (state: CycleState, updatedAt: Date): TokenCycle => ({
  appearedAt: state.appearedAt,
  launchPriceSol: state.launchPriceSol,
  appearedPriceSol: state.appearedPriceSol,
  riseBeforeAppearanceX: ratio(state.appearedPriceSol, state.launchPriceSol),
  appearedLate: state.lateAt !== null,
  phase: state.phase,
  runStartAt: state.runStartAt,
  explosionAt: state.explosionAt,
  investWindowSeconds: investWindowSeconds(state),
  peakAt: state.peakAt,
  peakX: ratio(state.peakPriceSol, state.appearedPriceSol),
  crashAt: state.crashAt,
  maxDrawdownPct: state.maxDrawdownPct === null ? null : round2(state.maxDrawdownPct),
  lastPriceX: ratio(state.lastPriceSol, state.appearedPriceSol),
  updatedAt,
});
