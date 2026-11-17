import { describe, expect, it } from "vitest";
import type { ClosedResult } from "./closed-result.js";
import { DEFAULT_REPUTATION_RULES, isBot, statsAt, tierOf, walletRecord } from "./reputation-rules.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date("2026-11-16T12:00:00.000Z");

const result = (pnlSol: number, closedAt: Date, overrides: Partial<ClosedResult> = {}): ClosedResult => ({
  mint: `m${closedAt.getTime()}${pnlSol}`,
  firstBuyAt: new Date(closedAt.getTime() - 30 * 60_000),
  firstSellAt: null,
  entrySeconds: 10,
  boughtSol: 1,
  soldSol: 1 + pnlSol,
  pnlSol,
  closedAt,
  ...overrides,
});

/** `wins` winners of `winPnl` and the rest losers of `lossPnl`, closed an hour apart before NOW. */
const results = (tokens: number, wins: number, winPnl: number, lossPnl: number): ClosedResult[] =>
  Array.from({ length: tokens }, (_, i) =>
    result(i < wins ? winPnl : lossPnl, new Date(NOW.getTime() - (i + 1) * HOUR)),
  );

const stats = (tokens: number, wins: number, netPnlSol: number) => ({ tokens, wins, netPnlSol });

describe("tierOf (D1 thresholds)", () => {
  it("rates a wallet good from 5 tokens, a 55% win rate and a positive net PnL", () => {
    expect(tierOf(stats(5, 3, 0.1), DEFAULT_REPUTATION_RULES)).toBe("good");
    expect(tierOf(stats(20, 11, 0.1), DEFAULT_REPUTATION_RULES)).toBe("good");
  });

  it("needs at least 5 closed tokens to be good", () => {
    expect(tierOf(stats(4, 4, 10), DEFAULT_REPUTATION_RULES)).toBe("none");
  });

  it("needs a win rate of at least 55% to be good", () => {
    expect(tierOf(stats(11, 6, 3), DEFAULT_REPUTATION_RULES)).toBe("none"); // 54.5%
  });

  it("needs a net PnL strictly above 0 SOL to be good", () => {
    expect(tierOf(stats(5, 5, 0), DEFAULT_REPUTATION_RULES)).toBe("none");
    expect(tierOf(stats(5, 5, -1), DEFAULT_REPUTATION_RULES)).toBe("none");
  });

  it("rates a wallet elite from 10 tokens, a 65% win rate and 5 SOL of net PnL", () => {
    expect(tierOf(stats(20, 13, 5), DEFAULT_REPUTATION_RULES)).toBe("elite");
  });

  it("keeps a wallet good when one elite threshold is missed", () => {
    expect(tierOf(stats(9, 9, 50), DEFAULT_REPUTATION_RULES)).toBe("good");
    expect(tierOf(stats(20, 12, 50), DEFAULT_REPUTATION_RULES)).toBe("good"); // 60%
    expect(tierOf(stats(20, 20, 4.99), DEFAULT_REPUTATION_RULES)).toBe("good");
  });

  it("uses configured thresholds instead of the defaults", () => {
    const rules = { ...DEFAULT_REPUTATION_RULES, good: { minTokens: 2, minWinRatePct: 50, minNetPnlSol: 1 } };
    expect(tierOf(stats(2, 1, 1.5), rules)).toBe("good");
    expect(tierOf(stats(2, 1, 1), rules)).toBe("none");
  });
});

describe("statsAt (point in time)", () => {
  it("counts only results closed before the moment, within the 7 days before it", () => {
    const at = new Date(NOW.getTime() - 2 * DAY);
    const counted = [
      result(1, new Date(at.getTime() - 1)),
      result(-0.5, new Date(at.getTime() - 7 * DAY)), // exactly 7 days before: included
    ];
    const ignored = [
      result(100, at), // closed at the moment itself
      result(100, new Date(at.getTime() + HOUR)), // look-ahead: closed after the buy
      result(100, new Date(at.getTime() - 7 * DAY - 1)), // too old
    ];

    expect(statsAt([...counted, ...ignored], at, DEFAULT_REPUTATION_RULES.lookbackMs)).toEqual({
      tokens: 2,
      wins: 1,
      netPnlSol: 0.5,
      flips: 0, // D7: stats also count flips
    });
  });

  it("never rates a buy with results that closed after it (look-ahead trap)", () => {
    const buyAt = new Date(NOW.getTime() - DAY);
    // Ten winning results, all closed after the buy: with look-ahead the wallet would be elite.
    const future = Array.from({ length: 10 }, (_, i) => result(2, new Date(buyAt.getTime() + (i + 1) * HOUR)));

    const atBuy = statsAt(future, buyAt, DEFAULT_REPUTATION_RULES.lookbackMs);

    expect(atBuy).toEqual({ tokens: 0, wins: 0, netPnlSol: 0, flips: 0 });
    expect(tierOf(atBuy, DEFAULT_REPUTATION_RULES)).toBe("none");
    expect(tierOf(statsAt(future, NOW, DEFAULT_REPUTATION_RULES.lookbackMs), DEFAULT_REPUTATION_RULES)).toBe("elite");
  });
});

describe("isBot", () => {
  it("flags a wallet that first-buys 20 distinct tokens per active hour on average", () => {
    const hour = new Date("2026-11-16T10:00:00.000Z").getTime();
    const busy = Array.from({ length: 40 }, (_, i) =>
      result(0.1, NOW, { mint: `b${i}`, firstBuyAt: new Date(hour + (i % 2) * HOUR + i * 1000) }),
    );
    expect(isBot(busy, DEFAULT_REPUTATION_RULES)).toBe(true); // 40 tokens in 2 hours
  });

  it("does not flag 19 tokens per active hour", () => {
    const hour = new Date("2026-11-16T10:00:00.000Z").getTime();
    const human = Array.from({ length: 38 }, (_, i) =>
      result(0.1, NOW, { mint: `h${i}`, firstBuyAt: new Date(hour + (i % 2) * HOUR + i * 1000) }),
    );
    expect(isBot(human, DEFAULT_REPUTATION_RULES)).toBe(false);
    expect(isBot([], DEFAULT_REPUTATION_RULES)).toBe(false);
  });
});

describe("walletRecord", () => {
  it("summarizes the last 7 days of closed results and explains the tier", () => {
    const record = walletRecord(
      "w1",
      [
        ...results(6, 4, 1.5, -0.25),
        result(50, new Date(NOW.getTime() - 8 * DAY)), // outside the 7 days
      ],
      NOW,
      DEFAULT_REPUTATION_RULES,
    );

    expect(record).toEqual({
      address: "w1",
      tier: "good",
      isBot: false,
      tokens: 6,
      wins: 4,
      winRate: 66.67,
      netPnlSol: 5.5,
      avgPnlSol: 0.916666667,
      medianEntrySeconds: 10,
      // D7 fields: never sold in its windows, so no flips and no hold time.
      style: "conviction",
      flipRate: 0,
      medianHoldSeconds: null,
      lastActiveAt: new Date(NOW.getTime() - HOUR - 30 * 60_000),
      updatedAt: NOW,
    });
  });

  it("reports an empty record for a wallet without recent results", () => {
    expect(walletRecord("w2", [], NOW, DEFAULT_REPUTATION_RULES)).toEqual({
      address: "w2",
      tier: "none",
      isBot: false,
      tokens: 0,
      wins: 0,
      winRate: 0,
      netPnlSol: 0,
      avgPnlSol: 0,
      medianEntrySeconds: null,
      style: "unrated",
      flipRate: null,
      medianHoldSeconds: null,
      lastActiveAt: null,
      updatedAt: NOW,
    });
  });

  it("takes the median entry time of an even number of results as the mean of the middle two", () => {
    const entries = [5, 30, 10, 60].map((entrySeconds, i) =>
      result(1, new Date(NOW.getTime() - (i + 1) * HOUR), { entrySeconds }),
    );
    expect(walletRecord("w3", entries, NOW, DEFAULT_REPUTATION_RULES).medianEntrySeconds).toBe(20);
  });

  it("rounds the median entry time to the millisecond", () => {
    const entries = [2.2, 2.283].map((entrySeconds, i) => result(1, new Date(NOW.getTime() - (i + 1) * HOUR), { entrySeconds }));
    expect(walletRecord("w4", entries, NOW, DEFAULT_REPUTATION_RULES).medianEntrySeconds).toBe(2.242);
  });
});
