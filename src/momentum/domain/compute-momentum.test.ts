import { describe, expect, it } from "vitest";
import { computeMomentum } from "./compute-momentum.js";
import type { Trade, TradeSide } from "./trade.js";

const NOW = new Date("2026-11-13T20:10:00.000Z");
const secondsAgo = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);

let counter = 0;
const trade = (trader: string, side: TradeSide, solAmount: number, ageSeconds: number, priceSol = 1): Trade => ({
  signature: `sig${counter++}`,
  mint: "mint",
  trader,
  side,
  solAmount,
  tokenAmount: solAmount / priceSol,
  priceSol,
  timestamp: secondsAgo(ageSeconds),
});

const buyers = (count: number, ageSeconds: number, prefix: string) =>
  Array.from({ length: count }, (_, i) => trade(`${prefix}${i}`, "buy", 0.1, ageSeconds));

describe("computeMomentum", () => {
  it("returns a zero score when there are no trades", () => {
    expect(computeMomentum([], NOW)).toEqual({
      score: 0,
      components: { activity: 0, acceleration: 0, buyPressure: 0 },
      metrics: {
        uniqueBuyers1m: 0,
        uniqueBuyers5m: 0,
        avgUniqueBuyersPrevMinutes: 0,
        buyVolumeSol5m: 0,
        sellVolumeSol5m: 0,
        tradeCount5m: 0,
        medianBuySol5m: 0,
        priceChange5mPct: 0,
        lastPriceSol: null,
      },
    });
  });

  it("counts each buyer once per window", () => {
    const trades = [trade("a", "buy", 0.1, 10), trade("a", "buy", 0.2, 20), trade("b", "buy", 0.1, 30)];

    const { metrics } = computeMomentum(trades, NOW);

    expect(metrics.uniqueBuyers1m).toBe(2);
    expect(metrics.uniqueBuyers5m).toBe(2);
    expect(metrics.tradeCount5m).toBe(3);
  });

  it("ignores trades older than five minutes or in the future", () => {
    const trades = [trade("old", "buy", 5, 301), trade("future", "buy", 5, -5), trade("ok", "buy", 1, 299)];

    const { metrics } = computeMomentum(trades, NOW);

    expect(metrics.uniqueBuyers5m).toBe(1);
    expect(metrics.buyVolumeSol5m).toBe(1);
  });

  it("excludes trades from the given traders, such as the creator", () => {
    const trades = [trade("creator", "buy", 2, 10), trade("fan", "buy", 0.1, 10)];

    const { metrics } = computeMomentum(trades, NOW, { excludedTraders: new Set(["creator"]) });

    expect(metrics.uniqueBuyers5m).toBe(1);
    expect(metrics.buyVolumeSol5m).toBe(0.1);
  });

  it("measures acceleration against the average of the previous four minutes", () => {
    const trades = [
      ...buyers(2, 90, "m2-"),
      ...buyers(2, 150, "m3-"),
      ...buyers(2, 210, "m4-"),
      ...buyers(2, 270, "m5-"),
      ...buyers(6, 30, "now-"),
    ];

    const result = computeMomentum(trades, NOW);

    expect(result.metrics.avgUniqueBuyersPrevMinutes).toBe(2);
    expect(result.metrics.uniqueBuyers1m).toBe(6);
    expect(result.components.acceleration).toBe(1);
  });

  it("gives no acceleration when buying is slowing down", () => {
    const trades = [...buyers(5, 90, "before-"), ...buyers(1, 30, "now-")];

    expect(computeMomentum(trades, NOW).components.acceleration).toBe(0);
  });

  it("does not over-reward tiny growth from almost nothing", () => {
    const trades = [trade("a", "buy", 0.1, 90), trade("b", "buy", 0.1, 30), trade("c", "buy", 0.1, 20)];

    // From an average of 0.25 buyers/min to 2: the base is floored at 2, so growth is (2 - 0.25) / 2.
    expect(computeMomentum(trades, NOW).components.acceleration).toBe(0.875);
  });

  it("derives buy pressure from bought vs sold SOL volume", () => {
    const trades = [trade("a", "buy", 3, 10), trade("b", "sell", 1, 20)];

    const result = computeMomentum(trades, NOW);

    expect(result.metrics.buyVolumeSol5m).toBe(3);
    expect(result.metrics.sellVolumeSol5m).toBe(1);
    expect(result.components.buyPressure).toBe(0.5);
  });

  it("gives no buy pressure when selling dominates", () => {
    const trades = [trade("a", "buy", 1, 10), trade("b", "sell", 3, 20)];

    expect(computeMomentum(trades, NOW).components.buyPressure).toBe(0);
  });

  it("caps activity at fifty unique buyers", () => {
    expect(computeMomentum(buyers(80, 100, "w"), NOW).components.activity).toBe(1);
    expect(computeMomentum(buyers(10, 100, "w"), NOW).components.activity).toBe(0.2);
  });

  it("computes median buy size and price change over the window", () => {
    const trades = [
      trade("a", "buy", 0.1, 240, 1),
      trade("b", "buy", 0.5, 120, 1.2),
      trade("c", "buy", 0.3, 10, 1.5),
      trade("d", "sell", 9, 5, 1.5),
    ];

    const { metrics } = computeMomentum(trades, NOW);

    expect(metrics.medianBuySol5m).toBe(0.3);
    expect(metrics.priceChange5mPct).toBe(50);
    expect(metrics.lastPriceSol).toBe(1.5);
  });

  it("combines components into a 0-100 score with fixed weights", () => {
    const trades = [...buyers(2, 90, "prev-"), ...buyers(48, 30, "now-")];

    const result = computeMomentum(trades, NOW);

    // activity = 50/50 = 1, acceleration = 1, buyPressure = 1 (no sells)
    expect(result.components).toEqual({ activity: 1, acceleration: 1, buyPressure: 1 });
    expect(result.score).toBe(100);
  });
});
