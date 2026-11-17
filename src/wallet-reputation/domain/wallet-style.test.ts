import { describe, expect, it } from "vitest";
import type { ClosedResult } from "./closed-result.js";
import { DEFAULT_REPUTATION_RULES, statsAt, styleOf, walletRecord } from "./reputation-rules.js";
import { closeTokenResults, type ObservedTrade } from "./wallet-positions.js";

/** Decision D7: hold time, flips and the point-in-time trading style. */

const DETECTED = new Date("2026-11-16T10:00:00.000Z");
const CLOSED = new Date("2026-11-16T11:00:00.000Z");
const at = (seconds: number) => new Date(DETECTED.getTime() + seconds * 1000);
const trade = (trader: string, side: "buy" | "sell", seconds: number): ObservedTrade => ({
  trader,
  side,
  solAmount: 1,
  tokenAmount: 100,
  priceSol: 0.01,
  timestamp: at(seconds),
});

describe("closeTokenResults hold time (first sell before the close)", () => {
  it("stores the first sell after the first buy and ignores sells before the buy or at or after the close", () => {
    const trades = [
      trade("early", "sell", 1), // before its first buy: opens nothing
      trade("early", "buy", 5),
      trade("early", "sell", 70),
      trade("early", "sell", 80),
      trade("holder", "buy", 10),
      trade("late", "buy", 20),
      trade("late", "sell", 3600), // exactly at the close: ignored
      trade("late", "sell", 3700), // after the close: ignored
    ];

    const { results } = closeTokenResults(trades, { creator: "dev", detectedAt: DETECTED }, CLOSED);

    expect(results.map(({ wallet, firstSellAt }) => [wallet, firstSellAt])).toEqual([
      ["early", at(70)],
      ["holder", null],
      ["late", null],
    ]);
  });
});

const NOW = new Date("2026-11-16T12:00:00.000Z");
const HOUR = 3_600_000;
const result = (closedAt: Date, holdSeconds: number | null, pnlSol = 1): ClosedResult => {
  const firstBuyAt = new Date(closedAt.getTime() - 30 * 60_000);
  return {
    mint: `m${closedAt.getTime()}`,
    firstBuyAt,
    firstSellAt: holdSeconds === null ? null : new Date(firstBuyAt.getTime() + holdSeconds * 1000),
    entrySeconds: 10,
    boughtSol: 1,
    soldSol: 1 + pnlSol,
    pnlSol,
    closedAt,
  };
};
/** `flips` results sold within 120 s and `tokens - flips` held longer, all winners closed before NOW. */
const history = (tokens: number, flips: number): ClosedResult[] =>
  Array.from({ length: tokens }, (_, i) => result(new Date(NOW.getTime() - (i + 1) * HOUR), i < flips ? 60 : 600));

describe("statsAt flips", () => {
  it("counts a flip when the first sell is at most 120 s after the first buy", () => {
    const results = [result(new Date(NOW.getTime() - HOUR), 120), result(new Date(NOW.getTime() - 2 * HOUR), 121), result(new Date(NOW.getTime() - 3 * HOUR), null)];

    expect(statsAt(results, NOW, DEFAULT_REPUTATION_RULES.lookbackMs)).toEqual({ tokens: 3, wins: 3, netPnlSol: 3, flips: 1 });
  });
});

describe("styleOf (D7 thresholds)", () => {
  const style = (tokens: number, wins: number, flips: number, netPnlSol = 1) =>
    styleOf({ tokens, wins, netPnlSol, flips }, DEFAULT_REPUTATION_RULES);

  it("rates good-or-elite wallets conviction up to a 30% flip rate", () => {
    expect(style(10, 10, 3)).toBe("conviction"); // 30%
    expect(style(10, 10, 0)).toBe("conviction");
    expect(style(20, 20, 6, 10)).toBe("conviction"); // elite, 30%
  });

  it("rates them flipper from a 60% flip rate and mixed in between", () => {
    expect(style(10, 10, 6)).toBe("flipper"); // 60%
    expect(style(10, 10, 10)).toBe("flipper");
    expect(style(10, 10, 4)).toBe("mixed"); // 40%
    expect(style(10, 10, 5)).toBe("mixed");
    expect(style(1000, 1000, 301)).toBe("mixed"); // 30.1%
    expect(style(1000, 1000, 599)).toBe("mixed"); // 59.9%
  });

  it("leaves wallets without a tier unrated, whatever their flip rate", () => {
    expect(style(4, 4, 0)).toBe("unrated");
    expect(style(10, 1, 9)).toBe("unrated");
    expect(style(0, 0, 0)).toBe("unrated");
  });

  it("uses configured thresholds", () => {
    const rules = { ...DEFAULT_REPUTATION_RULES, style: { flipWindowMs: 120_000, convictionMaxFlipRatePct: 10, flipperMinFlipRatePct: 20 } };
    expect(styleOf({ tokens: 10, wins: 10, netPnlSol: 1, flips: 1 }, rules)).toBe("conviction");
    expect(styleOf({ tokens: 10, wins: 10, netPnlSol: 1, flips: 2 }, rules)).toBe("flipper");
  });
});

describe("point-in-time style", () => {
  it("rates a buy only from results closed before it: a later-closed result never changes a past style", () => {
    const buyAt = new Date(NOW.getTime() - 30 * 60_000);
    // 5 held results closed before the buy: conviction at the buy.
    const before = Array.from({ length: 5 }, (_, i) => result(new Date(buyAt.getTime() - (i + 1) * HOUR), 600));
    // 10 flips closed after the buy (look-ahead if counted).
    const after = Array.from({ length: 10 }, (_, i) => result(new Date(buyAt.getTime() + (i + 1) * 60_000), 30));

    const atBuy = statsAt([...before, ...after], buyAt, DEFAULT_REPUTATION_RULES.lookbackMs);

    expect(styleOf(atBuy, DEFAULT_REPUTATION_RULES)).toBe("conviction");
    expect(styleOf(statsAt([...before, ...after], NOW, DEFAULT_REPUTATION_RULES.lookbackMs), DEFAULT_REPUTATION_RULES)).toBe("flipper");
  });
});

describe("walletRecord style", () => {
  it("adds the current style, flip rate and median hold time (unsold tokens excluded)", () => {
    const results = [...history(4, 3), result(new Date(NOW.getTime() - 10 * HOUR), null)];

    const record = walletRecord("w", results, NOW, DEFAULT_REPUTATION_RULES);

    expect([record.tier, record.style, record.flipRate, record.medianHoldSeconds]).toEqual(["good", "flipper", 60, 60]);
  });

  it("has no flip rate or hold time without closed results", () => {
    const record = walletRecord("w", [], NOW, DEFAULT_REPUTATION_RULES);

    expect([record.style, record.flipRate, record.medianHoldSeconds]).toEqual(["unrated", null, null]);
  });
});
