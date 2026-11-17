import { describe, expect, it } from "vitest";
import { closeTokenResults, foldPositions, isHolding, type ObservedTrade } from "./wallet-positions.js";

const DETECTED = new Date("2026-11-16T10:00:00.000Z");
const CLOSED = new Date("2026-11-16T11:00:00.000Z");
const at = (seconds: number) => new Date(DETECTED.getTime() + seconds * 1000);

const buy = (trader: string, seconds: number, solAmount: number, tokenAmount: number): ObservedTrade => ({
  trader,
  side: "buy",
  solAmount,
  tokenAmount,
  priceSol: solAmount / tokenAmount,
  timestamp: at(seconds),
});
const sell = (trader: string, seconds: number, solAmount: number, tokenAmount: number): ObservedTrade => ({
  ...buy(trader, seconds, solAmount, tokenAmount),
  side: "sell",
});

describe("foldPositions", () => {
  it("starts a position at the first buy and ignores sells before it", () => {
    const positions = foldPositions([sell("a", 1, 5, 100), buy("a", 2, 1, 100), sell("a", 3, 2, 50)], "dev");

    expect(positions.get("a")).toEqual({
      wallet: "a",
      firstBuyAt: at(2),
      firstBuyIndex: 1,
      boughtSol: 1,
      soldSol: 2,
      boughtTokens: 100,
      soldTokens: 50,
    });
  });

  it("excludes the token creator", () => {
    expect(foldPositions([buy("dev", 0, 1, 100)], "dev").size).toBe(0);
  });

  it("holds while the observed balance is positive and stops after a full sell", () => {
    const positions = foldPositions([buy("a", 1, 1, 100), sell("a", 2, 1, 40), buy("b", 3, 1, 10), sell("b", 4, 1, 10)], "dev");

    expect(isHolding(positions.get("a")!)).toBe(true);
    expect(isHolding(positions.get("b")!)).toBe(false);
  });
});

describe("closeTokenResults", () => {
  it("adds realized SOL and the remaining tokens at the last observed price, minus bought SOL", () => {
    const trades = [
      buy("dev", 0, 1, 1000), // creator: never gets a result for its own token
      buy("a", 5, 1, 1000), // price 0.001
      buy("b", 20, 2, 1000), // price 0.002
      sell("a", 60, 1.5, 500), // price 0.003
      sell("x", 61, 1, 100), // sold without an observed buy: no result
      buy("c", 120, 0.5, 125), // last price 0.004
    ];

    const { results, lastPriceSol } = closeTokenResults(trades, { creator: "dev", detectedAt: DETECTED }, CLOSED);

    expect(lastPriceSol).toBe(0.004);
    expect(results).toEqual([
      // 1.5 realized + 500 × 0.004 − 1 = 2.5
      { wallet: "a", firstBuyAt: at(5), entrySeconds: 5, boughtSol: 1, soldSol: 1.5, pnlSol: 2.5, closedAt: CLOSED },
      // 1000 × 0.004 − 2 = 2
      { wallet: "b", firstBuyAt: at(20), entrySeconds: 20, boughtSol: 2, soldSol: 0, pnlSol: 2, closedAt: CLOSED },
      // 125 × 0.004 − 0.5 = 0
      { wallet: "c", firstBuyAt: at(120), entrySeconds: 120, boughtSol: 0.5, soldSol: 0, pnlSol: 0, closedAt: CLOSED },
    ]);
  });

  it("values tokens sold beyond the observed buys at nothing", () => {
    const { results } = closeTokenResults(
      [buy("a", 1, 1, 100), sell("a", 2, 3, 300)],
      { creator: "dev", detectedAt: DETECTED },
      CLOSED,
    );
    expect(results[0]?.pnlSol).toBe(2);
  });

  it("returns no results for a token without trades", () => {
    expect(closeTokenResults([], { creator: "dev", detectedAt: DETECTED }, CLOSED)).toEqual({
      results: [],
      positions: new Map(),
      lastPriceSol: null,
    });
  });
});
