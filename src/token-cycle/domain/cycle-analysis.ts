import { median, round2 } from "../../wallet-reputation/domain/closed-result.js";

/** What the analysis needs of one stored cycle. */
export interface CycleSample {
  readonly appearedAt: Date;
  readonly appearedLate: boolean;
  readonly explosionAt: Date | null;
  readonly investWindowSeconds: number | null;
  readonly peakAt: Date | null;
  readonly peakX: number | null;
  readonly crashAt: Date | null;
}

export type WindowBucketLabel = "late" | "<1m" | "1-5m" | "5-15m" | "15-60m" | ">1h";

export interface WindowBucket {
  readonly label: WindowBucketLabel;
  readonly tokens: number;
  /** Over the bucket's tokens that exploded; null when none did. */
  readonly medianPeakX: number | null;
}

/** Aggregates of `GET /api/analysis/cycles`; statistics are null when there is nothing to compute them from. */
export interface CycleAnalysis {
  readonly tokens: number;
  readonly appearedInTimePct: number | null;
  readonly appearedLatePct: number | null;
  readonly explodedPct: number | null;
  readonly neverExplodedPct: number | null;
  readonly crashedPct: number | null;
  /** Over tokens that appeared in time and exploded. */
  readonly medianInvestWindowSeconds: number | null;
  /** Over tokens that exploded. */
  readonly medianPeakX: number | null;
  /** From appearing to the peak, over tokens that exploded. */
  readonly medianSecondsToPeak: number | null;
  /** Over tokens that crashed. */
  readonly medianSecondsPeakToCrash: number | null;
  readonly windowBuckets: readonly WindowBucket[];
}

/** Invest windows of tokens that appeared in time and exploded: each bucket starts at its lower limit (seconds). */
const WINDOW_BUCKETS: readonly { readonly label: WindowBucketLabel; readonly from: number }[] = [
  { label: "<1m", from: 0 },
  { label: "1-5m", from: 60 },
  { label: "5-15m", from: 300 },
  { label: "15-60m", from: 900 },
  { label: ">1h", from: 3600 },
];

const roundedMedian = (values: readonly number[]): number | null => {
  const value = median(values);
  return value === null ? null : round2(value);
};

const known = (values: readonly (number | null)[]): number[] => values.filter((value): value is number => value !== null);

const seconds = (from: Date, to: Date | null): number | null => (to === null ? null : (to.getTime() - from.getTime()) / 1000);

const bucketOf = (sample: CycleSample): WindowBucketLabel | null => {
  if (sample.appearedLate) return "late";
  const window = sample.investWindowSeconds;
  if (sample.explosionAt === null || window === null) return null;
  return WINDOW_BUCKETS.findLast((bucket) => window >= bucket.from)?.label ?? "<1m";
};

/** Share of public tokens that appeared in time, exploded and crashed, and how much window they gave. */
export const analyzeCycles = (samples: readonly CycleSample[]): CycleAnalysis => {
  const pct = (predicate: (sample: CycleSample) => boolean): number | null =>
    samples.length === 0 ? null : round2((samples.filter(predicate).length / samples.length) * 100);
  const exploded = samples.filter((sample) => sample.explosionAt !== null);
  const crashed = samples.filter((sample) => sample.crashAt !== null);
  const labels: readonly WindowBucketLabel[] = ["late", ...WINDOW_BUCKETS.map((bucket) => bucket.label)];

  return {
    tokens: samples.length,
    appearedInTimePct: pct((sample) => !sample.appearedLate),
    appearedLatePct: pct((sample) => sample.appearedLate),
    explodedPct: pct((sample) => sample.explosionAt !== null),
    neverExplodedPct: pct((sample) => sample.explosionAt === null),
    crashedPct: pct((sample) => sample.crashAt !== null),
    medianInvestWindowSeconds: roundedMedian(known(exploded.filter((sample) => !sample.appearedLate).map((sample) => sample.investWindowSeconds))),
    medianPeakX: roundedMedian(known(exploded.map((sample) => sample.peakX))),
    medianSecondsToPeak: roundedMedian(known(exploded.map((sample) => seconds(sample.appearedAt, sample.peakAt)))),
    medianSecondsPeakToCrash: roundedMedian(known(crashed.map((sample) => (sample.peakAt === null ? null : seconds(sample.peakAt, sample.crashAt))))),
    windowBuckets: labels.map((label) => {
      const inBucket = samples.filter((sample) => bucketOf(sample) === label);
      return { label, tokens: inBucket.length, medianPeakX: roundedMedian(known(inBucket.map((sample) => sample.peakX))) };
    }),
  };
};
