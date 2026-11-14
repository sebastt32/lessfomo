import type { Trade } from "./trade.js";

const MINUTE_MS = 60_000;
const WINDOW_MINUTES = 5;
/** Unique buyers in 5 minutes that count as full activity. */
const FULL_ACTIVITY_BUYERS = 50;
/** Floor for the acceleration base, so 0 → 2 buyers is not treated as infinite growth. */
const MIN_ACCELERATION_BASE = 2;

/**
 * Score v1 weights. This is a hypothesis, not a proven model:
 * stored snapshots exist precisely to validate or tune it later.
 */
export const MOMENTUM_WEIGHTS = { activity: 0.4, acceleration: 0.35, buyPressure: 0.25 } as const;

export interface MomentumMetrics {
  readonly uniqueBuyers1m: number;
  readonly uniqueBuyers5m: number;
  /** Average unique buyers per minute during the four minutes before the last one. */
  readonly avgUniqueBuyersPrevMinutes: number;
  readonly buyVolumeSol5m: number;
  readonly sellVolumeSol5m: number;
  readonly tradeCount5m: number;
  readonly medianBuySol5m: number;
  readonly priceChange5mPct: number;
  readonly lastPriceSol: number | null;
}

export interface MomentumComponents {
  /** 0-1: how many distinct wallets are buying. */
  readonly activity: number;
  /** 0-1: how fast buying grew in the last minute versus the minutes before. */
  readonly acceleration: number;
  /** 0-1: how much bought volume exceeds sold volume. */
  readonly buyPressure: number;
}

export interface Momentum {
  /** 0-100. */
  readonly score: number;
  readonly components: MomentumComponents;
  readonly metrics: MomentumMetrics;
}

export interface MomentumOptions {
  /** Traders whose trades do not count, e.g. the token creator. */
  readonly excludedTraders?: ReadonlySet<string>;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
const round = (value: number, decimals: number): number => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

const median = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
};

const uniqueBuyers = (trades: readonly Trade[]): number =>
  new Set(trades.filter((t) => t.side === "buy").map((t) => t.trader)).size;

/** Computes momentum metrics and score from the trades of one token at a given moment. */
export const computeMomentum = (trades: readonly Trade[], now: Date, options: MomentumOptions = {}): Momentum => {
  const nowMs = now.getTime();
  const ageMs = (trade: Trade) => nowMs - trade.timestamp.getTime();

  const recent = trades
    .filter((t) => !options.excludedTraders?.has(t.trader))
    .filter((t) => ageMs(t) >= 0 && ageMs(t) < WINDOW_MINUTES * MINUTE_MS)
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  const minuteBuckets = Array.from({ length: WINDOW_MINUTES }, (_, minute) =>
    recent.filter((t) => Math.floor(ageMs(t) / MINUTE_MS) === minute),
  );
  const buyersPerMinute = minuteBuckets.map(uniqueBuyers);
  const uniqueBuyers1m = buyersPerMinute[0] ?? 0;
  const previousMinutes = buyersPerMinute.slice(1);
  const avgPrev = previousMinutes.reduce((sum, n) => sum + n, 0) / previousMinutes.length;

  const buys = recent.filter((t) => t.side === "buy");
  const buyVolume = buys.reduce((sum, t) => sum + t.solAmount, 0);
  const sellVolume = recent.filter((t) => t.side === "sell").reduce((sum, t) => sum + t.solAmount, 0);
  const totalVolume = buyVolume + sellVolume;

  const first = recent[0];
  const last = recent.at(-1);
  const priceChange =
    first !== undefined && last !== undefined && first.priceSol > 0
      ? ((last.priceSol - first.priceSol) / first.priceSol) * 100
      : 0;

  const uniqueBuyers5m = uniqueBuyers(recent);
  const components: MomentumComponents = {
    activity: round(clamp01(uniqueBuyers5m / FULL_ACTIVITY_BUYERS), 4),
    acceleration: round(clamp01((uniqueBuyers1m - avgPrev) / Math.max(avgPrev, MIN_ACCELERATION_BASE)), 4),
    buyPressure: totalVolume > 0 ? round(clamp01((buyVolume / totalVolume - 0.5) * 2), 4) : 0,
  };

  const score = Math.round(
    100 *
      (MOMENTUM_WEIGHTS.activity * components.activity +
        MOMENTUM_WEIGHTS.acceleration * components.acceleration +
        MOMENTUM_WEIGHTS.buyPressure * components.buyPressure),
  );

  return {
    score,
    components,
    metrics: {
      uniqueBuyers1m,
      uniqueBuyers5m,
      avgUniqueBuyersPrevMinutes: round(avgPrev, 4),
      buyVolumeSol5m: round(buyVolume, 9),
      sellVolumeSol5m: round(sellVolume, 9),
      tradeCount5m: recent.length,
      medianBuySol5m: round(median(buys.map((t) => t.solAmount)), 9),
      priceChange5mPct: round(priceChange, 2),
      lastPriceSol: last?.priceSol ?? null,
    },
  };
};
