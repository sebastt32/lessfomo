import { median, round2 } from "./closed-result.js";
import type { ObservedTrade } from "./wallet-positions.js";

/** How the analysis trades each token. */
export interface OutcomeRules {
  /** Take profit at this multiple of the entry price. */
  readonly exitMultiple: number;
  /** Otherwise exit at the last price this long after the entry. */
  readonly holdMs: number;
  /** Round-trip cost, as a fraction, subtracted from every return. */
  readonly costRoundTrip: number;
  /** Tokens with at least this many smart wallets share the last bucket, entered at this wallet's buy. */
  readonly maxBucket: number;
}

export const DEFAULT_OUTCOME_RULES: OutcomeRules = { exitMultiple: 2, holdMs: 10 * 60_000, costRoundTrip: 0.03, maxBucket: 5 };

/** What copying the token's smart wallets would have returned. */
export interface TokenOutcome {
  /** Good-or-elite wallets (tier at entry) that bought the token in its live window. */
  readonly smartWallets: number;
  readonly entryAt: Date;
  readonly entryPriceSol: number;
  /** Net of the round-trip cost. */
  readonly returnPct: number;
  /** The exit target was hit within the holding time. */
  readonly reached2x: boolean;
  /** Highest price after the entry, over the rest of the live window, per entry price (at least 1). */
  readonly peakX: number;
}

const round6 = (value: number): number => Math.round(value * 1e6) / 1e6;

/**
 * Outcome of one token from its ordered trades. With k smart wallets the entry is the price right
 * after the k-th one's first buy (`smartFirstBuyIndexes`, in buy order; k capped at `maxBucket`);
 * with none it is the last price at or before the safety check. Null without an entry price.
 */
export const tokenOutcome = (
  trades: readonly ObservedTrade[],
  smartFirstBuyIndexes: readonly number[],
  screenedAt: Date | null,
  rules: OutcomeRules,
): TokenOutcome | null => {
  let entryIndex: number;
  let entryAt: Date;
  const k = Math.min(smartFirstBuyIndexes.length, rules.maxBucket);
  if (k > 0) {
    entryIndex = smartFirstBuyIndexes[k - 1]!;
    entryAt = trades[entryIndex]!.timestamp;
  } else {
    if (screenedAt === null) return null;
    entryIndex = trades.findLastIndex((trade) => trade.timestamp.getTime() <= screenedAt.getTime());
    entryAt = screenedAt;
  }
  const entryPriceSol = trades[entryIndex]?.priceSol;
  if (entryPriceSol === undefined || !(entryPriceSol > 0)) return null;

  const after = trades.slice(entryIndex + 1);
  const holdUntil = entryAt.getTime() + rules.holdMs;
  const target = entryPriceSol * rules.exitMultiple;
  let exitPriceSol = entryPriceSol;
  let reached2x = false;
  for (const trade of after) {
    if (trade.timestamp.getTime() > holdUntil) break;
    if (trade.priceSol >= target) {
      exitPriceSol = target;
      reached2x = true;
      break;
    }
    exitPriceSol = trade.priceSol;
  }
  const peak = after.reduce((highest, trade) => Math.max(highest, trade.priceSol), entryPriceSol);
  return {
    smartWallets: smartFirstBuyIndexes.length,
    entryAt,
    entryPriceSol,
    returnPct: round6((exitPriceSol / entryPriceSol - 1 - rules.costRoundTrip) * 100),
    reached2x,
    peakX: round6(peak / entryPriceSol),
  };
};

export interface OutcomeSample {
  readonly smartWallets: number;
  readonly returnPct: number;
  readonly reached2x: boolean;
  readonly peakX: number;
  /** The token migrated (as known now). */
  readonly migrated: boolean;
}

export interface AnalysisBucket {
  readonly smartWallets: string;
  readonly tokens: number;
  /** Null when the bucket has no tokens. */
  readonly reached2xPct: number | null;
  readonly migratedPct: number | null;
  readonly avgReturnPct: number | null;
  readonly medianReturnPct: number | null;
  readonly winnersPct: number | null;
  readonly medianPeakX: number | null;
}

const pctOf = (samples: readonly OutcomeSample[], predicate: (sample: OutcomeSample) => boolean): number =>
  round2((samples.filter(predicate).length / samples.length) * 100);

const roundOrNull = (value: number | null): number | null => (value === null ? null : round2(value));

/** Buckets `0`, `1`, ..., `maxBucket+` with the success statistics of their tokens. */
export const analyzeSmartWalletOutcomes = (
  samples: readonly OutcomeSample[],
  maxBucket = DEFAULT_OUTCOME_RULES.maxBucket,
): AnalysisBucket[] =>
  Array.from({ length: maxBucket + 1 }, (_, bucket) => {
    const label = bucket === maxBucket ? `${bucket}+` : String(bucket);
    const inBucket = samples.filter((sample) => Math.min(sample.smartWallets, maxBucket) === bucket);
    if (inBucket.length === 0) {
      return {
        smartWallets: label,
        tokens: 0,
        reached2xPct: null,
        migratedPct: null,
        avgReturnPct: null,
        medianReturnPct: null,
        winnersPct: null,
        medianPeakX: null,
      };
    }
    const returns = inBucket.map((sample) => sample.returnPct);
    return {
      smartWallets: label,
      tokens: inBucket.length,
      reached2xPct: pctOf(inBucket, (sample) => sample.reached2x),
      migratedPct: pctOf(inBucket, (sample) => sample.migrated),
      avgReturnPct: round2(returns.reduce((sum, value) => sum + value, 0) / returns.length),
      medianReturnPct: roundOrNull(median(returns)),
      winnersPct: pctOf(inBucket, (sample) => sample.returnPct > 0),
      medianPeakX: roundOrNull(median(inBucket.map((sample) => sample.peakX))),
    };
  });
