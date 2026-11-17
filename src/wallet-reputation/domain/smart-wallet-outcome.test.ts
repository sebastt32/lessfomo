import { describe, expect, it } from "vitest";
import {
  analyzeSmartWalletOutcomes,
  DEFAULT_OUTCOME_RULES,
  tokenOutcome,
  type OutcomeSample,
} from "./smart-wallet-outcome.js";
import type { ObservedTrade } from "./wallet-positions.js";

const START = new Date("2026-11-16T10:00:00.000Z").getTime();
const trade = (seconds: number, priceSol: number, trader = "t"): ObservedTrade => ({
  trader,
  side: "buy",
  solAmount: 1,
  tokenAmount: 1 / priceSol,
  priceSol,
  timestamp: new Date(START + seconds * 1000),
});

describe("tokenOutcome", () => {
  it("enters right after the k-th smart wallet's first buy and takes profit at 2x", () => {
    const trades = [trade(0, 1), trade(10, 1.2, "s1"), trade(20, 1.5, "s2"), trade(30, 3.1), trade(40, 6)];

    const outcome = tokenOutcome(trades, [1, 2], null, DEFAULT_OUTCOME_RULES);

    // Entry at s2's buy (1.5); 3.1 >= 3 hits the 2x target: 2 − 1 − 3% = 97%. Peak 6 / 1.5 = 4.
    expect(outcome).toEqual({
      smartWallets: 2,
      entryAt: new Date(START + 20_000),
      entryPriceSol: 1.5,
      returnPct: 97,
      reached2x: true,
      peakX: 4,
    });
  });

  it("exits at the last price of the 10 minutes when 2x is not reached", () => {
    const trades = [trade(0, 1, "s1"), trade(60, 1.5), trade(600, 1.2), trade(601, 5)];

    const outcome = tokenOutcome(trades, [0], null, DEFAULT_OUTCOME_RULES);

    // 1.2 / 1 − 1 = 20%, − 3% = 17%; the 5 after the 10 minutes only counts for the peak.
    expect(outcome).toMatchObject({ smartWallets: 1, returnPct: 17, reached2x: false, peakX: 5 });
  });

  it("uses the fifth smart wallet's first buy for 5 or more", () => {
    const trades = [1, 2, 3, 4, 5, 6].map((price, i) => trade(i, price, `s${i}`));
    expect(tokenOutcome(trades, [0, 1, 2, 3, 4, 5], null, DEFAULT_OUTCOME_RULES)).toMatchObject({
      smartWallets: 6,
      entryPriceSol: 5,
    });
  });

  it("enters at the safety-check time when no smart wallet bought", () => {
    const trades = [trade(0, 1), trade(50, 2), trade(70, 1.6), trade(200, 0.8)];

    const outcome = tokenOutcome(trades, [], new Date(START + 60_000), DEFAULT_OUTCOME_RULES);

    // Price at the check is the last trade before it (2); exit at 0.8: −60% − 3% = −63%.
    expect(outcome).toEqual({
      smartWallets: 0,
      entryAt: new Date(START + 60_000),
      entryPriceSol: 2,
      returnPct: -63,
      reached2x: false,
      peakX: 1,
    });
  });

  it("has no outcome without an entry price", () => {
    expect(tokenOutcome([], [], new Date(START), DEFAULT_OUTCOME_RULES)).toBeNull();
    expect(tokenOutcome([trade(10, 1)], [], new Date(START), DEFAULT_OUTCOME_RULES)).toBeNull();
    expect(tokenOutcome([trade(0, 1)], [], null, DEFAULT_OUTCOME_RULES)).toBeNull();
  });

  it("loses the round-trip cost when nothing trades after the entry", () => {
    expect(tokenOutcome([trade(0, 1, "s1")], [0], null, DEFAULT_OUTCOME_RULES)).toMatchObject({ returnPct: -3, peakX: 1 });
  });
});

describe("analyzeSmartWalletOutcomes", () => {
  const sample = (smartWallets: number, returnPct: number, peakX: number, migrated = false): OutcomeSample => ({
    smartWallets,
    returnPct,
    reached2x: returnPct >= 97,
    peakX,
    migrated,
  });

  it("buckets tokens by smart wallets 0..5+ with hand-computed statistics", () => {
    const buckets = analyzeSmartWalletOutcomes([
      sample(0, -3, 1),
      sample(0, -50, 1.2),
      sample(0, 17, 1.5),
      sample(0, -10, 1.1, true),
      sample(2, 97, 4, true),
      sample(2, -3, 1),
      sample(7, 97, 10),
      sample(5, 20, 1.4),
    ]);

    expect(buckets).toEqual([
      // returns −50, −10, −3, 17 → avg −11.5, median −6.5; 1 winner of 4; peaks 1, 1.1, 1.2, 1.5 → 1.15
      {
        smartWallets: "0",
        tokens: 4,
        reached2xPct: 0,
        migratedPct: 25,
        avgReturnPct: -11.5,
        medianReturnPct: -6.5,
        winnersPct: 25,
        medianPeakX: 1.15,
      },
      { smartWallets: "1", tokens: 0, reached2xPct: null, migratedPct: null, avgReturnPct: null, medianReturnPct: null, winnersPct: null, medianPeakX: null },
      {
        smartWallets: "2",
        tokens: 2,
        reached2xPct: 50,
        migratedPct: 50,
        avgReturnPct: 47,
        medianReturnPct: 47,
        winnersPct: 50,
        medianPeakX: 2.5,
      },
      { smartWallets: "3", tokens: 0, reached2xPct: null, migratedPct: null, avgReturnPct: null, medianReturnPct: null, winnersPct: null, medianPeakX: null },
      { smartWallets: "4", tokens: 0, reached2xPct: null, migratedPct: null, avgReturnPct: null, medianReturnPct: null, winnersPct: null, medianPeakX: null },
      {
        smartWallets: "5+",
        tokens: 2,
        reached2xPct: 50,
        migratedPct: 0,
        avgReturnPct: 58.5,
        medianReturnPct: 58.5,
        winnersPct: 100,
        medianPeakX: 5.7,
      },
    ]);
  });
});
