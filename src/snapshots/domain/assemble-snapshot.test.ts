import { describe, expect, it } from "vitest";
import { snapshotFromKnownState, snapshotFromQuote, snapshotFromTrades, type MarketQuote } from "./assemble-snapshot.js";

const AT = new Date("2026-11-14T01:00:00.000Z");
const HOUR = 3_600_000;
const curveLiquidity = { sol: 12.5, bondingCurvePct: 40.2, migrated: false };

const quote = (overrides: Partial<MarketQuote> = {}): MarketQuote => ({
  priceSol: 0.0000002,
  liquiditySol: null,
  migrated: false,
  windows: {
    m5: { volumeSol: 1, buys: 2, sells: 1 },
    h1: { volumeSol: 10, buys: 20, sells: 10 },
    h6: { volumeSol: 60, buys: 120, sells: 60 },
    h24: { volumeSol: 240, buys: 480, sells: 240 },
  },
  ...overrides,
});

describe("snapshotFromTrades", () => {
  it("uses the stored trades since the previous snapshot and the latest liquidity", () => {
    const snapshot = snapshotFromTrades({
      mint: "m",
      milestone: "5m",
      at: AT,
      window: { lastPriceSol: 0.00000004, volumeSol: 3.5, buys: 7, sells: 2, uniqueBuyers: 5 },
      liquidity: curveLiquidity,
      fallbackPriceSol: 0.00000003,
    });

    expect(snapshot).toEqual({
      mint: "m",
      milestone: "5m",
      at: AT,
      priceSol: 0.00000004,
      marketCapSol: 40,
      volumeSol: 3.5,
      buys: 7,
      sells: 2,
      uniqueBuyers: 5,
      holders: null,
      top10Pct: null,
      devHoldsPct: null,
      liquidity: curveLiquidity,
      source: "trades",
    });
  });

  it("falls back to the creation price before any trade was stored", () => {
    const snapshot = snapshotFromTrades({
      mint: "m",
      milestone: "0m",
      at: AT,
      window: { lastPriceSol: null, volumeSol: 0, buys: 0, sells: 0, uniqueBuyers: 0 },
      liquidity: { sol: null, bondingCurvePct: null, migrated: false },
      fallbackPriceSol: 0.00000003,
    });

    expect(snapshot).toMatchObject({ priceSol: 0.00000003, marketCapSol: 30, volumeSol: 0 });
  });
});

describe("snapshotFromQuote", () => {
  it("takes the DexScreener window that matches the time since the previous snapshot", () => {
    const snapshot = snapshotFromQuote({
      mint: "m",
      milestone: "2h",
      at: AT,
      quote: quote(),
      sincePreviousMs: HOUR + 20_000,
      knownLiquidity: curveLiquidity,
    });

    expect(snapshot).toEqual({
      mint: "m",
      milestone: "2h",
      at: AT,
      priceSol: 0.0000002,
      marketCapSol: 200,
      volumeSol: 10,
      buys: 20,
      sells: 10,
      uniqueBuyers: null,
      holders: null,
      top10Pct: null,
      devHoldsPct: null,
      liquidity: curveLiquidity,
      source: "mixed",
    });
  });

  it("leaves volume and counts unknown when no DexScreener window matches the gap", () => {
    const snapshot = snapshotFromQuote({
      mint: "m",
      milestone: "4h",
      at: AT,
      quote: quote(),
      sincePreviousMs: 2 * HOUR,
      knownLiquidity: curveLiquidity,
    });

    expect(snapshot).toMatchObject({ volumeSol: null, buys: null, sells: null, uniqueBuyers: null });
  });

  it("uses the pool liquidity once the token migrated", () => {
    const snapshot = snapshotFromQuote({
      mint: "m",
      milestone: "d2",
      at: AT,
      quote: quote({ liquiditySol: 85.3, migrated: true }),
      sincePreviousMs: 24 * HOUR,
      knownLiquidity: curveLiquidity,
    });

    expect(snapshot).toMatchObject({
      volumeSol: 240,
      liquidity: { sol: 85.3, bondingCurvePct: 100, migrated: true },
      source: "dexscreener",
    });
  });

  it("is a DexScreener snapshot when no liquidity is known at all", () => {
    const snapshot = snapshotFromQuote({
      mint: "m",
      milestone: "w2",
      at: AT,
      quote: quote(),
      sincePreviousMs: null,
      knownLiquidity: { sol: null, bondingCurvePct: null, migrated: false },
    });

    expect(snapshot).toMatchObject({ volumeSol: null, source: "dexscreener", liquidity: { sol: null } });
  });
});

describe("snapshotFromKnownState", () => {
  it("keeps the last known price and liquidity and leaves activity unknown", () => {
    expect(
      snapshotFromKnownState({ mint: "m", milestone: "6h", at: AT, lastPriceSol: 0.0000001, liquidity: curveLiquidity }),
    ).toMatchObject({
      priceSol: 0.0000001,
      marketCapSol: 100,
      volumeSol: null,
      buys: null,
      liquidity: curveLiquidity,
      source: "trades",
    });
  });
});
