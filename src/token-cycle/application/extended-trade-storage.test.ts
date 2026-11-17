import { afterEach, describe, expect, it } from "vitest";
import { SqliteHistoryRecorder } from "../../history/infrastructure/sqlite/sqlite-history-recorder.js";
import { MomentumTracker } from "../../momentum/application/momentum-tracker.js";
import type { Trade } from "../../momentum/domain/trade.js";
import type { NewToken } from "../../token-discovery/domain/new-token.js";
import { ReputationCloser } from "../../wallet-reputation/application/reputation-closer.js";
import { DEFAULT_REPUTATION_RULES } from "../../wallet-reputation/domain/reputation-rules.js";
import { ExtendedTradeStorage, routeTrade } from "./extended-trade-storage.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = new Date("2026-11-13T20:00:00.000Z").getTime();
const at = (ms: number): Date => new Date(T0 + ms);

let sequence = 0;
const trade = (mint: string, ms: number, overrides: Partial<Trade> = {}): Trade => ({
  signature: `sig-${(sequence += 1)}`,
  mint,
  trader: "fan",
  side: "buy",
  solAmount: 0.1,
  tokenAmount: 100,
  priceSol: 0.001,
  timestamp: at(ms),
  ...overrides,
});

/** A public token created at T0 whose trades are kept for 24 hours. */
const publicToken = (mint: string, appearedMs = MINUTE) => ({
  mint,
  creator: "dev",
  appearedAt: at(appearedMs),
  startsAt: at(HOUR),
  expiresAt: at(24 * HOUR),
});

describe("ExtendedTradeStorage", () => {
  it("keeps the trades of public tokens only, until their extended window ends", () => {
    const extended = new ExtendedTradeStorage({ maxTokens: 10 });
    extended.extend(publicToken("public"));

    expect(extended.record(trade("public", 2 * HOUR))).toBe(true);
    expect(extended.record(trade("public", 24 * HOUR - 1000))).toBe(true);
    expect(extended.record(trade("public", 24 * HOUR))).toBe(false);
    expect(extended.record(trade("other", 2 * HOUR))).toBe(false);
    expect(extended.has("public")).toBe(true);
    expect(extended.has("other")).toBe(false);
    expect(extended.creatorOf("public")).toBe("dev");
    expect(extended.creatorOf("other")).toBeUndefined();
  });

  it("never keeps a trade stamped inside the momentum window, even when nothing else is following the token", () => {
    // After a restart the momentum tracker follows no earlier token; the first hour must stay as on main.
    const extended = new ExtendedTradeStorage({ maxTokens: 10 });
    extended.extend(publicToken("public"));
    const idle = { record: () => false, isTracking: () => false };

    expect(routeTrade(trade("public", 40 * MINUTE), idle, extended)).toBe("ignored");
    expect(routeTrade(trade("public", HOUR - 1000), idle, extended)).toBe("ignored");
    expect(routeTrade(trade("public", HOUR), idle, extended)).toBe("extended");
  });

  it("does not keep again, after the window, a trade it already saw inside it", () => {
    const extended = new ExtendedTradeStorage({ maxTokens: 10 });
    extended.extend(publicToken("public"));
    const inside = trade("public", HOUR - 1000);

    expect(extended.record(inside)).toBe(false);
    expect(extended.record({ ...inside })).toBe(false);
  });

  it("accepts each trade once", () => {
    const extended = new ExtendedTradeStorage({ maxTokens: 10 });
    extended.extend(publicToken("public"));
    const first = trade("public", 2 * HOUR);

    expect(extended.record(first)).toBe(true);
    expect(extended.record({ ...first })).toBe(false);
    expect(extended.record({ ...first, side: "sell" })).toBe(true);
  });

  it("keeps the most recently appeared tokens when full", () => {
    const extended = new ExtendedTradeStorage({ maxTokens: 2 });

    expect(extended.extend(publicToken("first", 1 * MINUTE))).toEqual([]);
    expect(extended.extend(publicToken("second", 2 * MINUTE))).toEqual([]);
    // Extending a token again keeps it once.
    expect(extended.extend(publicToken("second", 2 * MINUTE))).toEqual([]);
    expect(extended.extend(publicToken("third", 3 * MINUTE))).toEqual(["first"]);
    // A token that appeared before every one kept is not taken.
    expect(extended.extend(publicToken("oldest", 0))).toEqual(["oldest"]);

    expect(extended.size()).toBe(2);
    expect(["first", "second", "third", "oldest"].filter((mint) => extended.has(mint))).toEqual(["second", "third"]);
    expect(extended.record(trade("first", 2 * HOUR))).toBe(false);
  });

  it("forgets tokens whose extended window ended and trades older than five minutes", () => {
    const extended = new ExtendedTradeStorage({ maxTokens: 10 });
    extended.extend(publicToken("a"));
    extended.extend({ ...publicToken("b"), expiresAt: at(2 * HOUR) });
    const old = trade("a", HOUR);
    extended.record(old);

    expect(extended.prune(at(HOUR + 4 * MINUTE))).toEqual([]);
    expect(extended.record({ ...old })).toBe(false);
    expect(extended.prune(at(2 * HOUR))).toEqual(["b"]);
    expect(extended.size()).toBe(1);
    // Forgotten after five minutes: bounded memory, like the momentum tracker.
    expect(extended.record({ ...old })).toBe(true);
  });
});

describe("routeTrade", () => {
  const WINDOW = HOUR;
  const setup = () => {
    const momentum = new MomentumTracker({ trackingWindowMs: WINDOW });
    const extended = new ExtendedTradeStorage({ maxTokens: 10 });
    momentum.track({ mint: "public", creator: "dev" }, at(0));
    momentum.track({ mint: "plain", creator: "dev" }, at(0));
    extended.extend(publicToken("public"));
    return { momentum, extended };
  };

  it("stores every trade of a tracked token once while the momentum window lasts", () => {
    const { momentum, extended } = setup();
    const first = trade("public", 5 * MINUTE);

    expect(routeTrade(first, momentum, extended)).toBe("live");
    expect(routeTrade({ ...first }, momentum, extended)).toBe("ignored");
    expect(routeTrade(trade("plain", 5 * MINUTE), momentum, extended)).toBe("live");
    expect(routeTrade(trade("unknown", 5 * MINUTE), momentum, extended)).toBe("ignored");
    expect(momentum.bufferedTradeCount()).toBe(2);
  });

  it("after the momentum window keeps storing public tokens and stops storing the others", () => {
    const { momentum, extended } = setup();
    const last = trade("public", 59 * MINUTE);
    expect(routeTrade(last, momentum, extended)).toBe("live");
    momentum.snapshot(at(WINDOW + 1000));

    expect(routeTrade(trade("public", WINDOW + 2000), momentum, extended)).toBe("extended");
    expect(routeTrade(trade("plain", WINDOW + 2000), momentum, extended)).toBe("ignored");
    // A trade already stored while it was tracked live is not stored or published again.
    expect(routeTrade({ ...last }, momentum, extended)).toBe("ignored");
    expect(routeTrade(trade("public", 24 * HOUR), momentum, extended)).toBe("ignored");
    // The momentum tracker's window did not change: it no longer follows the token.
    expect(momentum.trackedCount()).toBe(0);
    expect(momentum.isTracking("public")).toBe(false);
  });
});

describe("extended trades and the reputation close", () => {
  const stores: SqliteHistoryRecorder[] = [];
  afterEach(async () => {
    for (const store of stores.splice(0)) await store.close();
  });

  const token: NewToken = {
    mint: "a",
    name: "A",
    symbol: "A",
    creator: "dev",
    signature: "sig",
    metadataUri: "",
    bondingCurve: "curve",
    pool: "pump",
    initialBuyTokens: 0,
    initialBuySol: 0,
    marketCapSol: 30,
    detectedAt: at(0),
  };

  /** Closes the token after its 60-minute window, with or without trades stored in the extended window. */
  const closeWith = async (extendedTrades: readonly Trade[]) => {
    const store = new SqliteHistoryRecorder(":memory:");
    stores.push(store);
    await store.recordToken(token);
    const windowTrades: Trade[] = [
      trade("a", 0, { signature: "t1", trader: "dev", solAmount: 1, tokenAmount: 1000, priceSol: 0.001 }),
      trade("a", 5_000, { signature: "t2", trader: "w1", solAmount: 1, tokenAmount: 1000, priceSol: 0.001 }),
      trade("a", 20_000, { signature: "t3", trader: "w1", side: "sell", solAmount: 1.5, tokenAmount: 500, priceSol: 0.003 }),
      trade("a", 30_000, { signature: "t4", trader: "w2", solAmount: 2, tokenAmount: 1000, priceSol: 0.002 }),
    ];
    for (const stored of [...windowTrades, ...extendedTrades]) await store.recordTrade(stored);
    const closer = new ReputationCloser({ store, rules: DEFAULT_REPUTATION_RULES, trackingWindowMs: HOUR, clock: () => at(30 * HOUR) });
    await closer.tick();
    return {
      results: await store.walletResults(["w1", "w2", "w3", "dev"], new Date(0)),
      outcomes: await store.smartWalletOutcomes(at(-HOUR), at(HOUR)),
      closedAt: store.query("SELECT closed_at FROM token_closures WHERE mint = 'a'")[0]?.["closed_at"],
    };
  };

  it("closes at the same window with the same results: trades at or after the close never count", async () => {
    const without = await closeWith([]);
    const withExtended = await closeWith([
      trade("a", HOUR, { signature: "e1", trader: "w1", side: "sell", solAmount: 50, tokenAmount: 500, priceSol: 0.1 }),
      trade("a", 2 * HOUR, { signature: "e2", trader: "w3", solAmount: 3, tokenAmount: 10, priceSol: 0.3 }),
      trade("a", 5 * HOUR, { signature: "e3", trader: "w2", side: "sell", solAmount: 0.001, tokenAmount: 1000, priceSol: 0.000001 }),
    ]);

    expect(without.results).toHaveLength(2);
    expect(withExtended).toEqual(without);
    expect(withExtended.closedAt).toBe(T0 + HOUR);
  });
});
