import { describe, expect, it } from "vitest";
import { analyzeCycles, type CycleSample } from "./cycle-analysis.js";

const APPEARED = Date.UTC(2026, 10, 13, 20, 0, 0);
const after = (seconds: number | null): Date | null => (seconds === null ? null : new Date(APPEARED + seconds * 1000));

/** A token that appeared at a fixed time; peak and crash in seconds after it. */
const sample = (
  appearedLate: boolean,
  investWindowSeconds: number | null,
  peakX: number | null,
  peakSeconds: number | null,
  crashSeconds: number | null,
): CycleSample => ({
  appearedAt: new Date(APPEARED),
  appearedLate,
  explosionAt: after(peakSeconds === null ? null : 0),
  investWindowSeconds,
  peakAt: after(peakSeconds),
  peakX,
  crashAt: after(crashSeconds),
});

describe("cycle analysis", () => {
  it("aggregates a hand-computed set of cycles", () => {
    const samples = [
      sample(false, 30, 4, 200, 230),
      sample(false, 200, 2, 500, null),
      sample(false, 1000, 10, 3000, 4000),
      sample(false, null, null, null, null),
      sample(true, -60, null, null, null),
      sample(true, -10, 3, 100, 400),
      sample(false, 4000, 6, 5000, null),
      sample(false, 0, 2.5, 60, 100),
    ];

    expect(analyzeCycles(samples)).toEqual({
      tokens: 8,
      appearedInTimePct: 75,
      appearedLatePct: 25,
      explodedPct: 75,
      neverExplodedPct: 25,
      crashedPct: 50,
      // In-time tokens that exploded: 0, 30, 200, 1000, 4000.
      medianInvestWindowSeconds: 200,
      // Exploded tokens: 2, 2.5, 3, 4, 6, 10.
      medianPeakX: 3.5,
      // 60, 100, 200, 500, 3000, 5000.
      medianSecondsToPeak: 350,
      // 30, 40, 300, 1000.
      medianSecondsPeakToCrash: 170,
      windowBuckets: [
        { label: "late", tokens: 2, medianPeakX: 3 },
        { label: "<1m", tokens: 2, medianPeakX: 3.25 },
        { label: "1-5m", tokens: 1, medianPeakX: 2 },
        { label: "5-15m", tokens: 0, medianPeakX: null },
        { label: "15-60m", tokens: 1, medianPeakX: 10 },
        { label: ">1h", tokens: 1, medianPeakX: 6 },
      ],
    });
  });

  it("puts a window on a bucket limit in the higher bucket", () => {
    const labels = (seconds: number) =>
      analyzeCycles([sample(false, seconds, 2, 10, null)])
        .windowBuckets.filter((bucket) => bucket.tokens === 1)
        .map((bucket) => bucket.label);

    expect([59.999, 60, 299, 300, 899, 900, 3599, 3600].map((seconds) => labels(seconds)[0])).toEqual([
      "<1m",
      "1-5m",
      "1-5m",
      "5-15m",
      "5-15m",
      "15-60m",
      "15-60m",
      ">1h",
    ]);
  });

  it("answers null statistics when there are no tokens", () => {
    expect(analyzeCycles([])).toEqual({
      tokens: 0,
      appearedInTimePct: null,
      appearedLatePct: null,
      explodedPct: null,
      neverExplodedPct: null,
      crashedPct: null,
      medianInvestWindowSeconds: null,
      medianPeakX: null,
      medianSecondsToPeak: null,
      medianSecondsPeakToCrash: null,
      windowBuckets: ["late", "<1m", "1-5m", "5-15m", "15-60m", ">1h"].map((label) => ({ label, tokens: 0, medianPeakX: null })),
    });
  });

  it("answers null medians when no token exploded or crashed", () => {
    expect(analyzeCycles([sample(false, null, null, null, null)])).toMatchObject({
      tokens: 1,
      appearedInTimePct: 100,
      explodedPct: 0,
      neverExplodedPct: 100,
      crashedPct: 0,
      medianInvestWindowSeconds: null,
      medianPeakX: null,
      medianSecondsToPeak: null,
      medianSecondsPeakToCrash: null,
    });
  });
});
