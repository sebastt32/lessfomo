import { afterEach, describe, expect, it } from "vitest";
import { SqliteHistoryRecorder } from "../../history/infrastructure/sqlite/sqlite-history-recorder.js";
import type { Trade } from "../../momentum/domain/trade.js";
import type { TokenSnapshot } from "../../snapshots/domain/assemble-snapshot.js";
import type { NewToken } from "../../token-discovery/domain/new-token.js";
import type { SmartWalletEntry } from "../../wallet-reputation/domain/wallet-reputation-store.js";
import { DEFAULT_CYCLE_RULES, type TokenCycle } from "../domain/token-cycle.js";
import { ExtendedTradeStorage } from "./extended-trade-storage.js";
import { TokenCycleTracker, type TokenCycleTrackerOptions } from "./token-cycle-tracker.js";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 13, 20, 0, 0);
/** A moment `seconds` after the token's creation. */
const at = (seconds: number): Date => new Date(T0 + seconds * 1000);

const token = (mint: string, detectedAt = at(0)): NewToken => ({
  mint,
  name: `Name ${mint}`,
  symbol: mint.toUpperCase(),
  creator: "dev",
  signature: "sig",
  metadataUri: "",
  bondingCurve: "curve",
  pool: "pump",
  initialBuyTokens: 0,
  initialBuySol: 0,
  marketCapSol: 30,
  detectedAt,
});

let sequence = 0;
const trade = (mint: string, seconds: number, priceSol: number): Trade => ({
  signature: `sig-${(sequence += 1)}`,
  mint,
  trader: "fan",
  side: "buy",
  solAmount: 0.1,
  tokenAmount: 100,
  priceSol,
  timestamp: at(seconds),
});

const convictionWallet = (wallet: string, seconds: number): SmartWalletEntry => ({
  wallet,
  tierAtEntry: "good",
  styleAtEntry: "conviction",
  firstBuyAt: at(seconds),
  entrySeconds: seconds,
  boughtSol: 1,
  soldSol: 0,
  stillHolding: true,
});

const snapshot = (mint: string, milestone: string, seconds: number, priceSol: number): TokenSnapshot => ({
  mint,
  milestone,
  at: at(seconds),
  priceSol,
  marketCapSol: null,
  volumeSol: null,
  buys: null,
  sells: null,
  uniqueBuyers: null,
  holders: null,
  top10Pct: null,
  devHoldsPct: null,
  liquidity: { sol: null, bondingCurvePct: null, migrated: false },
  source: "dexscreener",
});

const stores: SqliteHistoryRecorder[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

const setup = (overrides: Partial<TokenCycleTrackerOptions> = {}, store = new SqliteHistoryRecorder(":memory:")) => {
  if (!stores.includes(store)) stores.push(store);
  const events: { mint: string; cycle: TokenCycle }[] = [];
  const updates: { mint: string; cycle: TokenCycle }[] = [];
  const logs: string[] = [];
  const errors: unknown[] = [];
  const firstBuys = new Map<string, Date[]>();
  const hidden = new Set<string>();
  let now = at(600);
  const extended = overrides.extended ?? new ExtendedTradeStorage({ maxTokens: 100 });
  const tracker = new TokenCycleTracker({
    store,
    rules: DEFAULT_CYCLE_RULES,
    extended,
    publicMinConvictionWallets: 2,
    publicTrackingMs: 24 * HOUR,
    trackingWindowMs: HOUR,
    convictionFirstBuys: (mint) => firstBuys.get(mint) ?? [],
    isPublic: async (mint) => !hidden.has(mint),
    onCycle: (mint, cycle) => updates.push({ mint, cycle }),
    onEvent: (mint, cycle) => events.push({ mint, cycle }),
    clock: () => now,
    log: (line) => logs.push(line),
    onError: (error) => errors.push(error),
    ...overrides,
  });
  /** Stores the trades, then tells the tracker like the pipeline does. */
  const trades = async (mint: string, ...points: [number, number][]): Promise<void> => {
    for (const [seconds, priceSol] of points) {
      await store.recordTrade(trade(mint, seconds, priceSol));
      tracker.tradeStored(mint);
    }
    await tracker.idle();
  };
  /** The live tracker rated the token's conviction wallets: it reached the public minimum. */
  const appear = async (mint: string, ...buySeconds: number[]): Promise<void> => {
    firstBuys.set(mint, buySeconds.map(at));
    tracker.smartWalletChanged(mint, buySeconds.length);
    await tracker.idle();
  };
  return { store, tracker, extended, events, updates, logs, errors, hidden, trades, appear, setNow: (date: Date) => (now = date) };
};

/** Launch 1, base 1.6 at 100 s: stable until the 3.2 trade at 200 s. */
const STABLE: [number, number][] = [[0, 1], [50, 1.5], [100, 1.6], [130, 1.8]];

describe("TokenCycleTracker", () => {
  describe("appearing", () => {
    it("does nothing until the token reaches the public minimum of conviction wallets", async () => {
      const { store, tracker, events, extended } = setup();
      await store.recordToken(token("a"));

      tracker.smartWalletChanged("a", 1);
      await tracker.idle();

      expect(await store.tokenCycle("a")).toBeNull();
      expect(events).toEqual([]);
      expect(extended.has("a")).toBe(false);
    });

    it("appears at the first buy that reached the minimum and starts the cycle from the trades stored up to then", async () => {
      const { store, events, updates, appear, trades } = setup();
      await store.recordToken(token("a"));
      await trades("a", ...STABLE);

      // Rated a moment later: the second conviction wallet had first bought at 100 s.
      await appear("a", 40, 100);

      const stored = await store.tokenCycle("a");
      expect(stored).toMatchObject({ caughtUp: true, state: { appearedAt: at(100), launchPriceSol: 1, appearedPriceSol: 1.6, phase: "stable" } });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        mint: "a",
        cycle: { appearedAt: at(100), launchPriceSol: 1, appearedPriceSol: 1.6, riseBeforeAppearanceX: 1.6, appearedLate: false, phase: "stable", lastPriceX: 1.125 },
      });
      expect(updates.at(-1)).toEqual(events[0]);
    });

    it("marks a token that had already doubled before appearing as late, with a negative window", async () => {
      const { store, events, appear, trades } = setup();
      await store.recordToken(token("a"));
      await trades("a", [0, 1], [30, 2.5], [100, 2.2]);

      await appear("a", 40, 100);

      expect(events[0]?.cycle).toMatchObject({ appearedLate: true, investWindowSeconds: -70, riseBeforeAppearanceX: 2.2 });
    });

    it("never changes when a token appeared, whatever its conviction wallets say later", async () => {
      const { store, tracker, appear, trades } = setup();
      await store.recordToken(token("a"));
      await trades("a", ...STABLE);
      await appear("a", 40, 100);

      // An exact re-rating finds an earlier second buyer, a restart forgets the token: neither moves it.
      await appear("a", 40, 60, 100);
      const restarted = setup({}, store);
      await restarted.appear("a", 10, 20);
      await store.saveSmartWallet("a", convictionWallet("w1", 10));
      await store.saveSmartWallet("a", convictionWallet("w2", 20));
      await restarted.tracker.backfillTick();
      await tracker.idle();

      expect((await store.tokenCycle("a"))?.state.appearedAt).toEqual(at(100));
      expect((await store.tokenCycle("a"))?.state.appearedPriceSol).toBe(1.6);
    });

    it("skips a token that was never stored", async () => {
      const { store, errors, appear } = setup();

      await appear("ghost", 40, 100);

      expect(await store.tokenCycle("ghost")).toBeNull();
      expect(errors).toEqual([]);
    });
  });

  describe("following a public token", () => {
    it("keeps the cycle updated with every stored trade, only from the trades seen so far", async () => {
      const { store, events, appear, trades } = setup();
      await store.recordToken(token("a"));
      await trades("a", ...STABLE);
      await appear("a", 40, 100);

      await trades("a", [160, 2.5]);
      expect((await store.tokenCycle("a"))?.state).toMatchObject({ phase: "stable", explosionAt: null, lastPriceSol: 2.5 });

      await trades("a", [200, 3.2]);
      const exploded = (await store.tokenCycle("a"))!.state;
      expect(exploded).toMatchObject({ phase: "exploding", explosionAt: at(200), runStartAt: at(130), peakPriceSol: 3.2 });

      // Later, higher and lower prices never move what was already recorded.
      await trades("a", [230, 4.8], [300, 6.4], [330, 3.2], [400, 100]);
      const crashed = (await store.tokenCycle("a"))!.state;
      expect(crashed).toMatchObject({ phase: "crashed", explosionAt: at(200), runStartAt: at(130), peakAt: at(300), crashAt: at(330), appearedAt: at(100) });
      expect(events.map((event) => event.cycle.phase)).toEqual(["stable", "exploding", "crashed"]);
    });

    it("ignores stored trades of tokens that are not public", async () => {
      const { store, events, updates, trades } = setup();
      await store.recordToken(token("a"));

      await trades("a", ...STABLE, [200, 9]);

      expect(await store.tokenCycle("a")).toBeNull();
      expect([...events, ...updates]).toEqual([]);
    });

    it("sends phase changes at once and new peaks at most once every 10 seconds", async () => {
      const { store, events, appear, trades } = setup({ eventMinIntervalMs: 10_000 });
      await store.recordToken(token("a"));
      await trades("a", ...STABLE);
      await appear("a", 40, 100);

      await trades("a", [200, 3.2]);
      await trades("a", [201, 4]);
      await trades("a", [202, 5], [203, 6]);
      expect(events.map((event) => event.cycle.phase)).toEqual(["stable", "exploding"]);

      await trades("a", [204, 2]);
      expect(events.map((event) => [event.cycle.phase, event.cycle.peakX])).toEqual([
        ["stable", null],
        ["exploding", 2],
        ["crashed", 3.75],
      ]);
    });

    it("sends a new peak when nothing was sent for 10 seconds, but not a plain price move", async () => {
      const { store, events, appear, trades } = setup({ eventMinIntervalMs: 0 });
      await store.recordToken(token("a"));
      await trades("a", ...STABLE);
      await appear("a", 40, 100);

      await trades("a", [200, 3.2]);
      await trades("a", [210, 3]);
      await trades("a", [220, 4]);

      expect(events.map((event) => event.cycle.peakX)).toEqual([null, 2, 2.5]);
    });

    it("never publishes the cycle of a token the visibility rule hides", async () => {
      const { store, events, hidden, appear, trades } = setup();
      await store.recordToken(token("a"));
      await trades("a", ...STABLE);
      hidden.add("a");

      await appear("a", 40, 100);
      await trades("a", [200, 3.2]);

      expect(events).toEqual([]);
      expect((await store.tokenCycle("a"))?.state.phase).toBe("exploding");
    });

    it("keeps storing the trades of a token that appeared until 24 hours after its creation", async () => {
      const { store, extended, tracker, appear, setNow } = setup();
      await store.recordToken(token("a"));
      await store.recordToken(token("old", at(-25 * 3600)));
      await store.recordTrade(trade("a", 100, 1));
      await store.recordTrade(trade("old", 100, 1));

      await appear("a", 40, 100);
      await appear("old", 40, 100);

      expect(extended.has("a")).toBe(true);
      expect(extended.record(trade("a", 5 * 3600, 2))).toBe(true);
      expect(extended.record(trade("a", 24 * 3600, 2))).toBe(false);
      // Created more than 24 hours ago: it gets its cycle, but no trade is stored for it any more.
      expect(extended.has("old")).toBe(false);
      expect(await store.tokenCycle("old")).not.toBeNull();

      setNow(at(24 * 3600));
      tracker.prune(at(24 * 3600));
      expect(extended.has("a")).toBe(false);
    });

    it("continues from snapshot prices once trades stopped, so late peaks and crashes are recorded", async () => {
      const { store, events, tracker, appear, trades } = setup({ eventMinIntervalMs: 0 });
      await store.recordToken(token("a"));
      await trades("a", ...STABLE, [200, 3.2]);
      await appear("a", 40, 100);

      await store.saveSnapshot(snapshot("a", "d2", 90_000, 16), {});
      tracker.snapshotSaved("a");
      await tracker.idle();
      await store.saveSnapshot(snapshot("a", "d3", 180_000, 4), {});
      tracker.snapshotSaved("a");
      tracker.snapshotSaved("unknown");
      await tracker.idle();

      expect((await store.tokenCycle("a"))?.state).toMatchObject({ phase: "crashed", peakAt: at(90_000), peakPriceSol: 16, crashAt: at(180_000) });
      expect(events.map((event) => event.cycle.phase)).toEqual(["exploding", "exploding", "crashed"]);
    });

    it("reports a storage failure instead of throwing, and keeps working", async () => {
      const { store, errors, appear, trades } = setup();
      await store.recordToken(token("a"));
      await trades("a", ...STABLE);
      await appear("a", 40, 100);
      const cycleTrades = store.cycleTrades.bind(store);
      let failures = 1;
      store.cycleTrades = async (...args) => {
        if (failures-- > 0) throw new Error("disk on fire");
        return cycleTrades(...args);
      };

      await trades("a", [200, 3.2]);
      expect(errors).toEqual([new Error("disk on fire")]);

      await trades("a", [230, 4.8]);
      expect((await store.tokenCycle("a"))?.state).toMatchObject({ phase: "exploding", explosionAt: at(200), peakPriceSol: 4.8 });
    });
  });

  describe("backfill", () => {
    /** A stored token with two conviction wallets (the second bought at 100 s) and a full cycle in its trades. */
    const publicToken = async (store: SqliteHistoryRecorder, mint: string, detectedAt = at(0)): Promise<void> => {
      await store.recordToken(token(mint, detectedAt));
      for (const [seconds, priceSol] of [...STABLE, [200, 3.2], [300, 6.4], [330, 3.2]] as [number, number][]) {
        await store.recordTrade(trade(mint, seconds, priceSol));
      }
      await store.saveSmartWallet(mint, convictionWallet("w1", 40));
      await store.saveSmartWallet(mint, convictionWallet("w2", 100));
    };

    it("computes when each public token appeared and its cycle from stored trades and snapshots, without events", async () => {
      const { store, tracker, events } = setup();
      await publicToken(store, "a");
      await store.saveSnapshot(snapshot("a", "1h", 3600, 0.4), {});
      await store.recordToken(token("plain"));
      await store.recordTrade(trade("plain", 10, 1));
      await store.saveSmartWallet("plain", convictionWallet("w1", 10));

      expect(await tracker.backfillTick()).toEqual({ processed: 1, backlog: false });

      const stored = await store.tokenCycle("a");
      expect(stored).toMatchObject({
        caughtUp: true,
        state: { appearedAt: at(100), appearedPriceSol: 1.6, phase: "crashed", runStartAt: at(130), explosionAt: at(200), peakAt: at(300), crashAt: at(330), lastPriceSol: 0.4 },
      });
      expect(await store.tokenCycle("plain")).toBeNull();
      expect(events).toEqual([]);
      // Nothing left: the next tick has no work.
      expect(await tracker.backfillTick()).toEqual({ processed: 0, backlog: false });
    });

    it("works in bounded batches, newest tokens first, logging its progress", async () => {
      const { store, tracker, logs } = setup({ backfillBatchSize: 2 });
      for (const [index, mint] of ["a", "b", "c", "d", "e"].entries()) await publicToken(store, mint, at(-index * 60));
      const done = async () => (await Promise.all(["a", "b", "c", "d", "e"].map(async (mint) => ((await store.tokenCycle(mint))?.caughtUp ? mint : "")))).join("");

      expect(await tracker.backfillTick()).toEqual({ processed: 2, backlog: true });
      expect(await done()).toBe("ab");
      expect(await tracker.backfillTick()).toEqual({ processed: 2, backlog: true });
      expect(await tracker.backfillTick()).toEqual({ processed: 1, backlog: false });
      expect(await done()).toBe("abcde");
      expect(logs.at(0)).toMatch(/^\[cycles\] backfilled 2 token cycle\(s\) \(detected down to .*\), backfilling\.\.\.$/);
      expect(logs.at(-1)).toMatch(/^\[cycles\] backfilled \d token cycle\(s\) .*, caught up$/);
    });

    it("resumes after a restart without computing finished cycles again", async () => {
      const first = setup({ backfillBatchSize: 2 });
      for (const [index, mint] of ["a", "b", "c"].entries()) await publicToken(first.store, mint, at(-index * 60));
      await first.tracker.backfillTick();
      const finished = await first.store.tokenCycle("a");

      const restarted = setup({ backfillBatchSize: 2 }, first.store);
      restarted.setNow(at(9000));
      expect(await restarted.tracker.backfillTick()).toEqual({ processed: 1, backlog: false });

      expect(await first.store.tokenCycle("a")).toEqual(finished);
      expect((await first.store.tokenCycle("c"))?.caughtUp).toBe(true);
      expect((await first.store.tokenCycle("c"))?.updatedAt).toEqual(at(9000));
    });

    it("finishes a cycle that a restart left half folded, from where it stopped", async () => {
      const { store } = setup();
      await publicToken(store, "a");
      const complete = setup({}, store);
      await complete.tracker.backfillTick();
      const expected = (await store.tokenCycle("a"))!.state;

      // The same token, stopped after its first batch of two trades.
      const other = new SqliteHistoryRecorder(":memory:");
      await publicToken(other, "a");
      const interrupted = setup({ pointsPerBatch: 2 }, other);
      const saveCycle = other.saveCycle.bind(other);
      let saves = 0;
      other.saveCycle = async (...args) => {
        if ((saves += 1) > 1) throw new Error("killed");
        return saveCycle(...args);
      };
      await interrupted.tracker.backfillTick();
      expect(await other.tokenCycle("a")).toMatchObject({ caughtUp: false, state: { tradeCursor: { at: at(50), count: 1 } } });
      other.saveCycle = saveCycle;

      const resumed = setup({ pointsPerBatch: 2 }, other);
      await resumed.tracker.backfillTick();

      expect((await other.tokenCycle("a"))?.caughtUp).toBe(true);
      expect((await other.tokenCycle("a"))?.state).toEqual(expected);
    });

    it("folds a long history in batches into the same cycle as in one go", async () => {
      const whole = setup();
      const batched = setup({ pointsPerBatch: 3 });
      for (const { store } of [whole, batched]) {
        await publicToken(store, "a");
        await store.recordTrade(trade("a", 330, 3));
        await store.recordTrade(trade("a", 330, 2.5));
        await store.saveSnapshot(snapshot("a", "1h", 3600, 0.4), {});
        await store.saveSnapshot(snapshot("a", "2h", 7200, 0.2), {});
      }

      await whole.tracker.backfillTick();
      await batched.tracker.backfillTick();

      expect((await batched.store.tokenCycle("a"))?.state).toEqual((await whole.store.tokenCycle("a"))?.state);
      expect((await batched.store.tokenCycle("a"))?.state).toMatchObject({ phase: "crashed", lastPriceSol: 0.2, snapshotCursorAt: at(7200) });
    });

    it("follows again, after a restart, the public tokens still inside their 24 hours", async () => {
      const first = setup();
      await publicToken(first.store, "recent", at(-3600));
      await publicToken(first.store, "old", at(-25 * 3600));
      await first.tracker.backfillTick();

      const restarted = setup({}, first.store);
      await restarted.tracker.restore();

      expect(restarted.extended.has("recent")).toBe(true);
      expect(restarted.extended.has("old")).toBe(false);
      expect(restarted.logs).toEqual(["[cycles] following 1 public token(s) trade by trade"]);
      // Trades stored from now on keep updating its cycle.
      await restarted.trades("recent", [500, 1]);
      expect((await first.store.tokenCycle("recent"))?.state.lastPriceSol).toBe(1);
    });
  });
});
