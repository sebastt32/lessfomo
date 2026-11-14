import { describe, expect, it } from "vitest";
import type { Trade } from "../domain/trade.js";
import { MomentumTracker } from "./momentum-tracker.js";

const T0 = new Date("2026-11-13T20:00:00.000Z").getTime();
const at = (seconds: number) => new Date(T0 + seconds * 1000);

const trade = (mint: string, trader: string, seconds: number): Trade => ({
  signature: `${mint}-${trader}-${seconds}`,
  mint,
  trader,
  side: "buy",
  solAmount: 0.1,
  tokenAmount: 100,
  priceSol: 0.001,
  timestamp: at(seconds),
});

describe("MomentumTracker", () => {
  it("only keeps trades of tracked tokens", () => {
    const tracker = new MomentumTracker({ trackingWindowMs: 3_600_000 });
    tracker.track({ mint: "a", creator: "dev" }, at(0));

    expect(tracker.record(trade("a", "fan", 10))).toBe(true);
    expect(tracker.record(trade("other", "fan", 10))).toBe(false);

    const snapshots = tracker.snapshot(at(30));
    expect(snapshots.map((s) => s.mint)).toEqual(["a"]);
    expect(snapshots[0]?.momentum.metrics.uniqueBuyers1m).toBe(1);
  });

  it("excludes the creator's own trades from the score", () => {
    const tracker = new MomentumTracker({ trackingWindowMs: 3_600_000 });
    tracker.track({ mint: "a", creator: "dev" }, at(0));
    tracker.record(trade("a", "dev", 5));
    tracker.record(trade("a", "fan", 6));

    expect(tracker.snapshot(at(30))[0]?.momentum.metrics.uniqueBuyers5m).toBe(1);
  });

  it("stops tracking a token once its tracking window ends", () => {
    const tracker = new MomentumTracker({ trackingWindowMs: 60_000 });
    tracker.track({ mint: "a", creator: "dev" }, at(0));

    expect(tracker.snapshot(at(59))).toHaveLength(1);
    expect(tracker.snapshot(at(61))).toHaveLength(0);
    expect(tracker.record(trade("a", "fan", 62))).toBe(false);
    expect(tracker.trackedCount()).toBe(0);
  });

  it("forgets trades older than five minutes to bound memory", () => {
    const tracker = new MomentumTracker({ trackingWindowMs: 3_600_000 });
    tracker.track({ mint: "a", creator: "dev" }, at(0));
    tracker.record(trade("a", "early", 10));

    tracker.snapshot(at(400));

    expect(tracker.bufferedTradeCount()).toBe(0);
  });

  it("ignores duplicate trades with the same signature", () => {
    const tracker = new MomentumTracker({ trackingWindowMs: 3_600_000 });
    tracker.track({ mint: "a", creator: "dev" }, at(0));

    expect(tracker.record(trade("a", "fan", 10))).toBe(true);
    expect(tracker.record(trade("a", "fan", 10))).toBe(false);
    expect(tracker.snapshot(at(30))[0]?.momentum.metrics.tradeCount5m).toBe(1);
  });
});
