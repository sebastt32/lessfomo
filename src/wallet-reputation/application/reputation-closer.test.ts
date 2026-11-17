import { afterEach, describe, expect, it } from "vitest";
import { SqliteHistoryRecorder } from "../../history/infrastructure/sqlite/sqlite-history-recorder.js";
import type { Trade } from "../../momentum/domain/trade.js";
import type { NewToken } from "../../token-discovery/domain/new-token.js";
import { DEFAULT_REPUTATION_RULES, type WalletRecord } from "../domain/reputation-rules.js";
import { ReputationCloser, type ReputationCloserOptions } from "./reputation-closer.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const WINDOW = HOUR;
const T0 = new Date("2026-11-16T00:00:00.000Z").getTime();

const token = (mint: string, detectedAt: number, creator = "dev"): NewToken => ({
  mint,
  name: `Name ${mint}`,
  symbol: mint.toUpperCase(),
  creator,
  signature: "sig",
  metadataUri: "",
  bondingCurve: "curve",
  pool: "pump",
  initialBuyTokens: 0,
  initialBuySol: 0,
  marketCapSol: 30,
  detectedAt: new Date(detectedAt),
});

let sequence = 0;
const trade = (mint: string, trader: string, side: "buy" | "sell", at: number, solAmount: number, tokenAmount: number): Trade => ({
  signature: `s${(sequence += 1)}`,
  mint,
  trader,
  side,
  solAmount,
  tokenAmount,
  priceSol: solAmount / tokenAmount,
  timestamp: new Date(at),
});

const stores: SqliteHistoryRecorder[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

const setup = (now: number, overrides: Partial<ReputationCloserOptions> = {}) => {
  const store = new SqliteHistoryRecorder(":memory:");
  stores.push(store);
  const pushed: WalletRecord[] = [];
  const logs: string[] = [];
  let clock = now;
  const make = (extra: Partial<ReputationCloserOptions> = {}) =>
    new ReputationCloser({
      store,
      rules: DEFAULT_REPUTATION_RULES,
      trackingWindowMs: WINDOW,
      clock: () => new Date(clock),
      onRecords: (records) => pushed.push(...records),
      log: (line) => logs.push(line),
      ...overrides,
      ...extra,
    });
  return { store, pushed, logs, make, setNow: (value: number) => (clock = value) };
};

/** A token where `wallet` buys at `buyAt` and sells everything 1 minute later at twice the price. */
const winningToken = async (store: SqliteHistoryRecorder, mint: string, detectedAt: number, wallet: string, buyAt = detectedAt + MINUTE) => {
  await store.recordToken(token(mint, detectedAt));
  await store.recordTrade(trade(mint, "dev", "buy", detectedAt, 1, 1000));
  await store.recordTrade(trade(mint, wallet, "buy", buyAt, 1, 1000));
  await store.recordTrade(trade(mint, wallet, "sell", buyAt + MINUTE, 2, 1000));
};

describe("ReputationCloser", () => {
  it("closes tokens whose window ended, storing every buyer's result but the creator's", async () => {
    const { store, make } = setup(T0 + 2 * HOUR);
    await store.recordToken(token("a", T0));
    await store.recordTrade(trade("a", "dev", "buy", T0, 1, 1000));
    await store.recordTrade(trade("a", "w1", "buy", T0 + 5_000, 1, 1000)); // 0.001
    await store.recordTrade(trade("a", "w2", "buy", T0 + 10_000, 2, 1000)); // 0.002
    await store.recordTrade(trade("a", "w1", "sell", T0 + 20_000, 1.5, 500)); // 0.003
    await store.recordToken(token("open", T0 + 90 * MINUTE)); // still in its live window

    expect(await make().tick()).toMatchObject({ closed: 1 });

    expect(await store.walletResults(["w1", "w2", "dev"], new Date(0))).toEqual([
      expect.objectContaining({ wallet: "w2", mint: "a", boughtSol: 2, soldSol: 0, pnlSol: 1, closedAt: new Date(T0 + WINDOW) }),
      expect.objectContaining({ wallet: "w1", mint: "a", entrySeconds: 5, boughtSol: 1, soldSol: 1.5, pnlSol: 2 }),
    ]);
    expect((await store.closableTokens(null, new Date(T0 + 3 * HOUR), 10)).map((t) => t.mint)).toEqual(["open"]);
  });

  it("is idempotent: closing again or after a restart stores nothing twice", async () => {
    const { store, make } = setup(T0 + 3 * HOUR);
    await winningToken(store, "a", T0, "w1");

    await make().tick();
    await make().tick();
    await make().tick();

    expect(store.query("SELECT COUNT(*) AS n FROM wallet_token_results")[0]?.["n"]).toBe(1);
    expect(store.query("SELECT COUNT(*) AS n FROM token_closures")[0]?.["n"]).toBe(1);
  });

  it("backfills in bounded batches and resumes after a restart where it stopped", async () => {
    const { store, make, logs } = setup(T0 + 30 * HOUR);
    for (let i = 0; i < 5; i += 1) await winningToken(store, `t${i}`, T0 + i * HOUR, "w1");

    expect(await make({ batchSize: 2 }).tick()).toMatchObject({ closed: 2, backlog: true });
    const restarted = make({ batchSize: 2 });
    expect(await restarted.tick()).toMatchObject({ closed: 2, backlog: true });
    expect(await restarted.tick()).toMatchObject({ closed: 1, backlog: false });
    expect(await restarted.tick()).toMatchObject({ closed: 0, backlog: false });

    expect(store.query("SELECT COUNT(*) AS n FROM token_closures")[0]?.["n"]).toBe(5);
    expect(logs.some((line) => line.startsWith("[reputation] closed"))).toBe(true);
  });

  it("rates smart wallets at their buy with results closed before it only (no look-ahead)", async () => {
    // w1 wins 5 tokens; the last result closes at T0 + 4h + window = T0 + 5h.
    const { store, make } = setup(T0 + 30 * HOUR);
    for (let i = 0; i < 5; i += 1) await winningToken(store, `win${i}`, T0 + i * HOUR, "w1");
    // Bought before the 5th result closed: not good yet at that buy, even though it is good now.
    await winningToken(store, "early", T0 + 4 * HOUR + 30 * MINUTE, "w1", T0 + 4 * HOUR + 59 * MINUTE);
    // Bought after it closed: good at that buy.
    await winningToken(store, "late", T0 + 4 * HOUR + 40 * MINUTE, "w1", T0 + 5 * HOUR + MINUTE);

    await make({ batchSize: 100 }).tick();

    expect(await store.tokenSmartWallets("early")).toEqual([]);
    expect(await store.tokenSmartWallets("late")).toEqual([
      {
        wallet: "w1",
        tierAtEntry: "good",
        styleAtEntry: "flipper", // D7: every prior token was sold 1 minute after the buy
        firstBuyAt: new Date(T0 + 5 * HOUR + MINUTE),
        entrySeconds: 21 * 60,
        boughtSol: 1,
        soldSol: 2,
        stillHolding: false,
      },
    ]);
    const outcomes = await store.smartWalletOutcomes(new Date(T0), new Date(T0 + 30 * HOUR));
    // Without a safety check, tokens nobody smart bought have no entry, so only "late" has an outcome.
    expect(outcomes.map((o) => o.smartWallets)).toEqual([1]);
  });

  it("refreshes the records of the wallets it closed and pushes them", async () => {
    const { store, make, pushed } = setup(T0 + 6 * HOUR);
    for (let i = 0; i < 5; i += 1) await winningToken(store, `win${i}`, T0 + i * 10 * MINUTE, "w1");

    await make().tick();

    expect(pushed).toEqual([expect.objectContaining({ address: "w1", tier: "good", tokens: 5, wins: 5, netPnlSol: 5 })]);
    expect(await store.smartWalletRecords(10)).toEqual([expect.objectContaining({ address: "w1", tier: "good" })]);
  });

  it("loads the stored smart records on start and refreshes stale records as they age", async () => {
    const { store, make, pushed, setNow } = setup(T0 + 6 * HOUR);
    for (let i = 0; i < 5; i += 1) await winningToken(store, `win${i}`, T0 + i * 10 * MINUTE, "w1");
    await make().tick();
    pushed.length = 0;

    const closer = make();
    await closer.loadRecords();
    expect(pushed.map((r) => [r.address, r.tier])).toEqual([["w1", "good"]]);

    // Eight days later every result left the 7 days: the record decays to none.
    pushed.length = 0;
    setNow(T0 + 8 * 24 * HOUR);
    await closer.tick();
    expect(pushed.map((r) => [r.address, r.tier, r.tokens])).toEqual([["w1", "none", 0]]);
    expect(await store.smartWalletRecords(10)).toEqual([]);
  });

  describe("hold times and conviction (decision D7)", () => {
    /** A token where `wallet` buys 1 minute in and first sells `holdMs` later at twice the price. */
    const heldToken = async (store: SqliteHistoryRecorder, mint: string, detectedAt: number, wallet: string, holdMs: number) => {
      await store.recordToken(token(mint, detectedAt));
      await store.recordTrade(trade(mint, "dev", "buy", detectedAt, 1, 1000));
      await store.recordTrade(trade(mint, wallet, "buy", detectedAt + MINUTE, 1, 1000));
      await store.recordTrade(trade(mint, wallet, "sell", detectedAt + MINUTE + holdMs, 2, 1000));
    };
    const RAW = ["tokens", "trades", "screenings", "momentum_snapshots", "token_snapshots"];
    const dump = (store: SqliteHistoryRecorder, table: string) => JSON.stringify(store.query(`SELECT * FROM ${table} ORDER BY 1, 2`));

    it("stores the first sell before the close and never one after it", async () => {
      const { store, make } = setup(T0 + 10 * HOUR);
      await store.recordToken(token("a", T0));
      await store.recordTrade(trade("a", "w1", "buy", T0 + MINUTE, 1, 1000));
      await store.recordTrade(trade("a", "w1", "sell", T0 + 3 * MINUTE, 1, 500));
      await store.recordTrade(trade("a", "w2", "buy", T0 + MINUTE, 1, 1000));
      await store.recordTrade(trade("a", "w2", "sell", T0 + WINDOW + 1, 1, 1000)); // after the close

      await make().tick();

      expect(store.query("SELECT wallet, first_sell_at FROM wallet_token_results ORDER BY wallet")).toEqual([
        { wallet: "w1", first_sell_at: T0 + 3 * MINUTE },
        { wallet: "w2", first_sell_at: null },
      ]);
    });

    it("rates conviction from earlier closes only, and a later flip never changes a past style", async () => {
      const { store, make } = setup(T0 + 30 * HOUR);
      // Five held wins (10 minutes), closing by T0 + 5h: conviction from then on.
      for (let i = 0; i < 5; i += 1) await heldToken(store, `held${i}`, T0 + i * HOUR, "w1", 10 * MINUTE);
      // Bought right after the 5th close: conviction at that buy.
      await heldToken(store, "x", T0 + 5 * HOUR, "w1", 10 * MINUTE);
      // Then many flips close; a buy after them is a flipper.
      for (let i = 0; i < 10; i += 1) await heldToken(store, `flip${i}`, T0 + 6 * HOUR + i * MINUTE, "w1", 30_000);
      await heldToken(store, "y", T0 + 7 * HOUR + 20 * MINUTE, "w1", 10 * MINUTE);

      await make({ batchSize: 100 }).tick();

      const styleIn = (mint: string) => store.query(`SELECT style_at_entry FROM token_smart_wallets WHERE mint = '${mint}'`);
      expect(styleIn("x")).toEqual([{ style_at_entry: "conviction" }]);
      expect(styleIn("y")).toEqual([{ style_at_entry: "flipper" }]);
      expect(await store.tokenSmartSummary("x")).toEqual({ count: 1, elite: 0, holding: 0, conviction: 1 });
      expect(await store.tokenSmartSummary("y")).toEqual({ count: 1, elite: 1, holding: 0, conviction: 0 }); // elite by then, but a flipper (10 of 16)
    });

    it("closes tokens of an older version again, oldest first, backfilling hold times and styles without touching raw tables", async () => {
      const { store, make } = setup(T0 + 30 * HOUR);
      for (let i = 0; i < 5; i += 1) await heldToken(store, `held${i}`, T0 + i * HOUR, "w1", 10 * MINUTE);
      await heldToken(store, "x", T0 + 5 * HOUR, "w1", 10 * MINUTE);
      await store.recordScreening({ token: token("x", T0), status: "unverified", reason: "test" }, new Date(T0 + 5 * HOUR + MINUTE));
      await make({ batchSize: 100 }).tick();
      const derived = ["wallet_token_results", "token_smart_wallets", "smart_wallet_tokens", "smart_wallet_outcomes", "conviction_outcomes"];
      const expected = derived.map((table) => dump(store, table));
      const raw = RAW.map((table) => dump(store, table));
      // What a database closed before D7 looks like.
      store.query("UPDATE token_closures SET version = NULL");
      store.query("UPDATE wallet_token_results SET first_sell_at = NULL");
      store.query("UPDATE token_smart_wallets SET style_at_entry = NULL");
      store.query("UPDATE smart_wallet_tokens SET conviction = 0");
      store.query("DELETE FROM conviction_outcomes");

      const restarted = make({ batchSize: 2 });
      const ticks = [];
      for (let i = 0; i < 10; i += 1) {
        const result = await restarted.tick();
        ticks.push(result.closed);
        if (!result.backlog) break;
      }

      expect(ticks).toEqual([2, 2, 2, 0]); // a full batch reports a backlog, so one empty tick ends it
      expect(derived.map((table) => dump(store, table))).toEqual(expected);
      expect(RAW.map((table) => dump(store, table))).toEqual(raw);
      expect(store.query("SELECT COUNT(*) AS n FROM token_closures WHERE version = 2")).toEqual([{ n: 6 }]);
    });

    it("stores the conviction outcome entered after the k-th conviction wallet's first buy", async () => {
      const { store, make } = setup(T0 + 30 * HOUR);
      for (let i = 0; i < 5; i += 1) {
        await heldToken(store, `c${i}`, T0 + i * HOUR, "conv", 10 * MINUTE);
        await heldToken(store, `f${i}`, T0 + i * HOUR + 1, "flip", 30_000);
      }
      const D = T0 + 6 * HOUR;
      await store.recordToken(token("z", D));
      await store.recordTrade(trade("z", "dev", "buy", D, 1, 1000)); // 0.001
      await store.recordTrade(trade("z", "flip", "buy", D + MINUTE, 1, 500)); // 0.002: smart entry for k=1
      await store.recordTrade(trade("z", "conv", "buy", D + 2 * MINUTE, 1, 250)); // 0.004: smart k=2, conviction k=1
      await store.recordTrade(trade("z", "other", "buy", D + 3 * MINUTE, 1, 125)); // 0.008: 2x the conviction entry

      await make({ batchSize: 100 }).tick();

      const range = [new Date(D - 1), new Date(D + 1)] as const;
      expect(await store.smartWalletOutcomes(...range)).toEqual([
        { smartWallets: 2, returnPct: 97, reached2x: true, peakX: 2, migrated: false },
      ]);
      expect(await store.convictionOutcomes(...range)).toEqual([
        { smartWallets: 1, returnPct: 97, reached2x: true, peakX: 2, migrated: false },
      ]);
      expect(store.query("SELECT entry_price_sol FROM conviction_outcomes WHERE mint = 'z'")).toEqual([{ entry_price_sol: 0.004 }]);
    });
  });
});
