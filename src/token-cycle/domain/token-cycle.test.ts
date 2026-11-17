import { describe, expect, it } from "vitest";
import {
  advanceCycle,
  DEFAULT_CYCLE_RULES,
  startCycle,
  summarizeCycle,
  tradePoints,
  type CyclePoint,
  type CycleState,
} from "./token-cycle.js";

const T0 = Date.UTC(2026, 10, 13, 20, 0, 0);
/** A moment `seconds` after the token's creation. */
const at = (seconds: number): Date => new Date(T0 + seconds * 1000);
/** Ordered trades as `[seconds, price]`. */
const trades = (...points: [number, number][]): CyclePoint[] => tradePoints(points.map(([seconds, priceSol]) => ({ at: at(seconds), priceSol })));
const snapshot = (seconds: number, priceSol: number): CyclePoint => ({ kind: "snapshot", at: at(seconds), priceSol });
const UPDATED_AT = at(999);

/** The cycle of a token that appeared `appearedSeconds` after its creation, after these trades. */
const cycleAfter = (appearedSeconds: number, points: readonly CyclePoint[], from?: CycleState): CycleState =>
  advanceCycle(from ?? startCycle(at(appearedSeconds)), points, DEFAULT_CYCLE_RULES);
const summary = (state: CycleState) => summarizeCycle(state, UPDATED_AT);

/** Hand-computed: launch 1, appears at 100 s with base 1.6, explodes at 200 s, peaks at 6.4, crashes at 330 s. */
const FULL_CYCLE: [number, number][] = [
  [0, 1.0],
  [50, 1.5],
  [100, 1.6],
  [130, 1.8],
  [160, 2.5],
  [200, 3.2],
  [230, 4.8],
  [260, 3.6],
  [300, 6.4],
  [330, 3.2],
  [400, 1.6],
];

describe("token cycle", () => {
  it("uses the D1 thresholds by default", () => {
    expect(DEFAULT_CYCLE_RULES).toMatchObject({ explosionMultiple: 2, runStartMultiple: 1.2, crashFraction: 0.5, lateMultiple: 2 });
  });

  it("is stable while the price stays under 2× the base price at appearance", () => {
    const state = cycleAfter(100, trades(...FULL_CYCLE.slice(0, 5)));

    expect(summary(state)).toEqual({
      appearedAt: at(100),
      launchPriceSol: 1,
      appearedPriceSol: 1.6,
      riseBeforeAppearanceX: 1.6,
      appearedLate: false,
      phase: "stable",
      runStartAt: null,
      explosionAt: null,
      investWindowSeconds: null,
      peakAt: null,
      peakX: null,
      crashAt: null,
      maxDrawdownPct: null,
      lastPriceX: 1.5625,
      updatedAt: UPDATED_AT,
    });
  });

  it("goes stable → exploding → crashed over a hand-computed cycle", () => {
    const exploding = cycleAfter(100, trades(...FULL_CYCLE.slice(0, 8)));
    expect(summary(exploding)).toMatchObject({
      phase: "exploding",
      runStartAt: at(130),
      explosionAt: at(200),
      investWindowSeconds: 30,
      peakAt: at(230),
      peakX: 3,
      crashAt: null,
      maxDrawdownPct: 25,
      lastPriceX: 2.25,
    });

    const crashed = cycleAfter(100, trades(...FULL_CYCLE));
    expect(summary(crashed)).toEqual({
      appearedAt: at(100),
      launchPriceSol: 1,
      appearedPriceSol: 1.6,
      riseBeforeAppearanceX: 1.6,
      appearedLate: false,
      phase: "crashed",
      runStartAt: at(130),
      explosionAt: at(200),
      investWindowSeconds: 30,
      peakAt: at(300),
      peakX: 4,
      crashAt: at(330),
      maxDrawdownPct: 75,
      lastPriceX: 1,
      updatedAt: UPDATED_AT,
    });
  });

  it("takes the base price from the last trade at or before appearing, later trades of that second included", () => {
    const state = cycleAfter(100, trades([0, 1], [100, 1.4], [100, 1.5], [101, 1.7]));

    expect(summary(state)).toMatchObject({ launchPriceSol: 1, appearedPriceSol: 1.5, riseBeforeAppearanceX: 1.5, lastPriceX: 1.1333 });
  });

  it("appeared late: the price had already reached 2× its launch price, so the window is negative", () => {
    const state = cycleAfter(100, trades([0, 1], [40, 2], [70, 3], [100, 2.4], [150, 2.5]));

    expect(summary(state)).toMatchObject({
      appearedLate: true,
      riseBeforeAppearanceX: 2.4,
      investWindowSeconds: -60,
      phase: "stable",
      runStartAt: null,
      explosionAt: null,
    });
  });

  it("keeps the negative window of a late token even after it explodes from its base", () => {
    const state = cycleAfter(100, trades([0, 1], [40, 2], [100, 2.4], [150, 2.5], [180, 4.8]));

    expect(summary(state)).toMatchObject({
      appearedLate: true,
      investWindowSeconds: -60,
      phase: "exploding",
      runStartAt: at(150),
      explosionAt: at(180),
      peakX: 2,
    });
  });

  it("starts the run at the appearance when no trade before the explosion was at most 1.2× the base", () => {
    const state = cycleAfter(100, trades([0, 8], [100, 10], [110, 15], [120, 25]));

    expect(summary(state)).toMatchObject({ phase: "exploding", runStartAt: at(100), explosionAt: at(120), investWindowSeconds: 0 });
  });

  it("starts the run at the last calm trade, not the first", () => {
    const state = cycleAfter(100, trades([0, 8], [100, 10], [110, 11], [120, 15], [130, 9], [140, 13], [150, 20]));

    expect(summary(state)).toMatchObject({ runStartAt: at(130), explosionAt: at(150), investWindowSeconds: 30 });
  });

  describe("boundaries", () => {
    it("explodes at exactly 2× the base, not just below", () => {
      expect(cycleAfter(100, trades([0, 8], [100, 10], [110, 19.999])).phase).toBe("stable");
      expect(summary(cycleAfter(100, trades([0, 8], [100, 10], [110, 20])))).toMatchObject({ phase: "exploding", explosionAt: at(110), peakX: 2 });
    });

    it("counts a trade at exactly 1.2× the base as calm, not one just above", () => {
      expect(cycleAfter(100, trades([0, 8], [100, 10], [110, 12], [120, 20])).runStartAt).toEqual(at(110));
      expect(cycleAfter(100, trades([0, 8], [100, 10], [110, 12.001], [120, 20])).runStartAt).toEqual(at(100));
    });

    it("crashes at exactly 50% of the peak, not just above", () => {
      const before = trades([0, 8], [100, 10], [110, 20], [120, 40]);
      expect(summary(cycleAfter(100, [...before, ...trades([130, 20.001])])).phase).toBe("exploding");
      expect(summary(cycleAfter(100, [...before, ...trades([130, 20])]))).toMatchObject({ phase: "crashed", crashAt: at(130), maxDrawdownPct: 50 });
    });

    it("is late at exactly 2× the launch price, not just below", () => {
      expect(summary(cycleAfter(100, trades([0, 5], [50, 9.999], [100, 6]))).appearedLate).toBe(false);
      expect(summary(cycleAfter(100, trades([0, 5], [50, 10], [100, 6])))).toMatchObject({ appearedLate: true, investWindowSeconds: -50 });
    });
  });

  it("sets a new peak after a partial dip and measures the crash from it", () => {
    const state = cycleAfter(100, trades([0, 8], [100, 10], [110, 20], [120, 30], [130, 18], [140, 50], [150, 26]));

    // 18 is a 40% dip from 30 (no crash); 26 is 48% under the new peak of 50 (still no crash).
    expect(summary(state)).toMatchObject({ phase: "exploding", peakAt: at(140), peakX: 5, crashAt: null, maxDrawdownPct: 48 });
    expect(summary(cycleAfter(100, trades([160, 25]), state))).toMatchObject({ phase: "crashed", peakAt: at(140), crashAt: at(160) });
  });

  it("freezes the peak at the crash; later trades only move the last price and the drawdown", () => {
    const crashed = cycleAfter(100, trades(...FULL_CYCLE));
    const later = cycleAfter(100, trades(...FULL_CYCLE, [450, 8], [460, 0.8]));

    expect(summary(later)).toMatchObject({
      phase: "crashed",
      peakAt: summary(crashed).peakAt,
      peakX: 4,
      crashAt: at(330),
      maxDrawdownPct: 87.5,
      lastPriceX: 0.5,
    });
  });

  describe("no look-ahead", () => {
    it("derives every prefix only from the trades seen so far", () => {
      const all = trades(...FULL_CYCLE);
      let state = startCycle(at(100));
      const phases: string[] = [];
      for (const [index, point] of all.entries()) {
        state = advanceCycle(state, [point], DEFAULT_CYCLE_RULES);
        // Feeding one trade at a time equals computing the prefix from scratch.
        expect(state).toEqual(cycleAfter(100, all.slice(0, index + 1)));
        phases.push(state.phase);
      }
      expect(phases).toEqual(["stable", "stable", "stable", "stable", "stable", "exploding", "exploding", "exploding", "exploding", "crashed", "crashed"]);
    });

    it("never moves a recorded explosion, run start or crash when later prices are higher or lower", () => {
      const exploded = cycleAfter(100, trades(...FULL_CYCLE.slice(0, 6)));
      const later = cycleAfter(100, trades([210, 1.7], [220, 100], [230, 1]), exploded);

      expect(later.explosionAt).toEqual(exploded.explosionAt);
      expect(later.runStartAt).toEqual(exploded.runStartAt);
      expect(summary(later).investWindowSeconds).toBe(30);
      expect(later.appearedPriceSol).toBe(1.6);
      expect(later.launchPriceSol).toBe(1);
      expect(later.crashAt).toEqual(at(230));
      expect(cycleAfter(100, trades([240, 1000], [250, 0.1]), later).crashAt).toEqual(at(230));
    });

    it("never changes when it appeared", () => {
      const state = cycleAfter(100, trades(...FULL_CYCLE, [500, 9]));

      expect(state.appearedAt).toEqual(at(100));
    });

    it("is not late because of a price reached after appearing", () => {
      const state = cycleAfter(100, trades([0, 1], [100, 1.5], [120, 9]));

      expect(summary(state)).toMatchObject({ appearedLate: false, phase: "exploding", investWindowSeconds: 0 });
    });
  });

  describe("re-feeding", () => {
    it("is idempotent: the same trades again change nothing", () => {
      const all = trades(...FULL_CYCLE);
      const once = cycleAfter(100, all);

      expect(cycleAfter(100, all, once)).toEqual(once);
      expect(cycleAfter(100, all.slice(3), once)).toEqual(once);
    });

    it("does not crash a token by replaying the calm trade of the second it exploded in", () => {
      const all = trades([0, 8], [100, 10], [110, 10], [110, 20]);
      const once = cycleAfter(100, all);

      expect(once.phase).toBe("exploding");
      expect(cycleAfter(100, all, once)).toEqual(once);
    });

    it("continues from a prefix exactly as if everything had been fed at once, also inside one second", () => {
      const all = trades([0, 8], [100, 10], [110, 11], [110, 21], [110, 30], [120, 14]);

      for (let cut = 0; cut <= all.length; cut += 1) {
        expect(cycleAfter(100, all, cycleAfter(100, all.slice(0, cut)))).toEqual(cycleAfter(100, all));
      }
      expect(cycleAfter(100, all).phase).toBe("crashed");
    });
  });

  describe("snapshot prices", () => {
    it("continue the cycle once trades stopped: late peaks and crashes are recorded", () => {
      const exploding = cycleAfter(100, trades([0, 8], [100, 10], [110, 20]));
      const state = cycleAfter(100, [snapshot(4000, 60), snapshot(8000, 25)], exploding);

      expect(summary(state)).toMatchObject({ phase: "crashed", peakAt: at(4000), peakX: 6, crashAt: at(8000), lastPriceX: 2.5 });
    });

    it("are ignored while trades are flowing (within the quiet gap after the last trade) and before appearing", () => {
      const state = cycleAfter(100, [snapshot(3, 50), ...trades([0, 8], [100, 10], [110, 12]), snapshot(111, 99), snapshot(230, 99)]);

      expect(summary(state)).toMatchObject({ launchPriceSol: 8, appearedPriceSol: 10, phase: "stable", lastPriceX: 1.2 });
      expect(summary(cycleAfter(100, [snapshot(231, 99)], state))).toMatchObject({ phase: "exploding", explosionAt: at(231) });
    });

    it("are used once each", () => {
      const exploding = cycleAfter(100, trades([0, 8], [100, 10], [110, 20]));
      const once = cycleAfter(100, [snapshot(4000, 60)], exploding);

      expect(cycleAfter(100, [snapshot(4000, 60), snapshot(3000, 1)], once)).toEqual(once);
    });
  });

  it("uses the first trade seen as launch and base when none was stored before appearing", () => {
    const state = cycleAfter(100, trades([120, 4], [130, 8]));

    expect(summary(state)).toMatchObject({ launchPriceSol: 4, appearedPriceSol: 4, appearedLate: false, phase: "exploding", runStartAt: at(120) });
  });

  it("has no prices before the first trade", () => {
    expect(summary(startCycle(at(100)))).toMatchObject({
      launchPriceSol: null,
      appearedPriceSol: null,
      riseBeforeAppearanceX: null,
      appearedLate: false,
      phase: "stable",
      lastPriceX: null,
    });
  });

  it("numbers trades of the same second in order", () => {
    expect(tradePoints([{ at: at(1), priceSol: 1 }, { at: at(1), priceSol: 2 }, { at: at(2), priceSol: 3 }]).map((p) => p.ordinal)).toEqual([0, 1, 0]);
  });
});
