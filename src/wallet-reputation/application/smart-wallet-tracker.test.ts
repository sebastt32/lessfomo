import { describe, expect, it } from "vitest";
import type { Trade } from "../../momentum/domain/trade.js";
import type { ReputationStats } from "../domain/closed-result.js";
import { DEFAULT_REPUTATION_RULES, type WalletRecord, type WalletTier } from "../domain/reputation-rules.js";
import type { SmartWalletEntry, WalletBuy } from "../domain/wallet-reputation-store.js";
import { SmartWalletTracker, type SmartWalletChange } from "./smart-wallet-tracker.js";

const DETECTED = new Date("2026-11-16T10:00:00.000Z");
const at = (seconds: number) => new Date(DETECTED.getTime() + seconds * 1000);

const record = (address: string, tier: WalletTier): WalletRecord => ({
  address,
  tier,
  isBot: false,
  tokens: 12,
  wins: 9,
  winRate: 75,
  netPnlSol: 8,
  avgPnlSol: 0.666666667,
  medianEntrySeconds: 20,
  lastActiveAt: at(-60),
  updatedAt: at(-30),
});

const trade = (trader: string, side: "buy" | "sell", seconds: number, tokenAmount = 1000, mint = "m"): Trade => ({
  signature: `${trader}${side}${seconds}`,
  mint,
  trader,
  side,
  solAmount: 0.5,
  tokenAmount,
  priceSol: 0.5 / tokenAmount,
  timestamp: at(seconds),
});

const GOOD_STATS: ReputationStats = { tokens: 5, wins: 4, netPnlSol: 2, flips: 0 };
const ELITE_STATS: ReputationStats = { tokens: 12, wins: 9, netPnlSol: 8, flips: 0 };

const setup = () => {
  const changes: SmartWalletChange[] = [];
  const saved: { mint: string; entry: SmartWalletEntry }[] = [];
  const asked: { buys: readonly WalletBuy[]; excludedMint: string }[] = [];
  /** Point-in-time stats the store answers, per wallet (absent = no results). */
  const stats = new Map<string, ReputationStats>([
    ["good", GOOD_STATS],
    ["elite", ELITE_STATS],
    ["dev", ELITE_STATS],
  ]);
  const tracker = new SmartWalletTracker({
    trackingWindowMs: 3_600_000,
    rules: DEFAULT_REPUTATION_RULES,
    statsAtBuys: async (buys, excludedMint) => {
      asked.push({ buys, excludedMint });
      return new Map(buys.flatMap(({ wallet }) => (stats.has(wallet) ? [[wallet, stats.get(wallet)!] as const] : [])));
    },
    onChange: (change) => changes.push(change),
    persist: (mint, entry) => saved.push({ mint, entry }),
  });
  tracker.updateRecords([record("good", "good"), record("elite", "elite"), record("dev", "elite")]);
  tracker.track({ mint: "m", creator: "dev", detectedAt: DETECTED });
  return { tracker, changes, saved, asked, stats };
};

describe("SmartWalletTracker", () => {
  it("counts good and elite wallets at their first buy and reports each one", async () => {
    const { tracker, changes, saved } = setup();

    tracker.tradeRecorded(trade("good", "buy", 5));
    tracker.tradeRecorded(trade("nobody", "buy", 6));
    tracker.tradeRecorded(trade("elite", "buy", 7));
    await tracker.rateThrough(at(7));

    expect(tracker.summary("m")).toEqual({ count: 2, elite: 1, holding: 2, conviction: 2 });
    expect(changes.map((change) => [change.wallet.wallet, change.smartWallets])).toEqual([
      ["good", { count: 1, elite: 0, holding: 1, conviction: 1 }],
      ["elite", { count: 2, elite: 1, holding: 2, conviction: 2 }],
    ]);
    expect(changes[0]?.wallet).toEqual({
      wallet: "good",
      tierAtEntry: "good",
      styleAtEntry: "conviction",
      firstBuyAt: at(5),
      entrySeconds: 5,
      boughtSol: 0.5,
      soldSol: 0,
      stillHolding: true,
      record: record("good", "good"),
    });
    expect(saved.map(({ mint, entry }) => [mint, entry.wallet])).toEqual([
      ["m", "good"],
      ["m", "elite"],
    ]);
  });

  it("never counts the token creator, even when it is elite", async () => {
    const { tracker, changes } = setup();

    tracker.tradeRecorded(trade("dev", "buy", 1));
    await tracker.rateThrough(at(10));

    expect(tracker.summary("m")).toEqual({ count: 0, elite: 0, holding: 0, conviction: 0 });
    expect(changes).toEqual([]);
  });

  it("keeps the tier of the first buy fixed when the wallet's stats change later", async () => {
    const { tracker, stats } = setup();
    tracker.tradeRecorded(trade("good", "buy", 1));
    await tracker.rateThrough(at(1));

    stats.set("good", ELITE_STATS);
    tracker.tradeRecorded(trade("good", "buy", 2));
    await tracker.rateThrough(at(2));

    expect(tracker.summary("m")).toEqual({ count: 1, elite: 0, holding: 1, conviction: 1 });
  });

  it("ignores a wallet whose first buy came before it was good", async () => {
    const { tracker, stats } = setup();
    tracker.tradeRecorded(trade("later", "buy", 1));
    await tracker.rateThrough(at(1));

    stats.set("later", GOOD_STATS);
    tracker.tradeRecorded(trade("later", "buy", 2));
    await tracker.rateThrough(at(2));

    expect(tracker.summary("m").count).toBe(0);
  });

  it("rates a first buy only once every result closed before it is stored, with its stats at that buy", async () => {
    const { tracker, changes, asked } = setup();
    tracker.tradeRecorded(trade("good", "buy", 5));
    tracker.tradeRecorded(trade("good", "buy", 6));

    await tracker.rateThrough(at(4));
    expect(tracker.summary("m").count).toBe(0);
    expect(asked).toEqual([]);

    await tracker.rateThrough(at(5));
    expect(asked).toEqual([{ buys: [{ wallet: "good", at: at(5) }], excludedMint: "m" }]);
    // Trades seen while it waited are part of its position.
    expect(changes.map((change) => change.wallet.boughtSol)).toEqual([1]);
    expect(tracker.summary("m")).toEqual({ count: 1, elite: 0, holding: 1, conviction: 1 });
  });

  it("never rates a buy with a cached record: a stale good record does not count", async () => {
    const { tracker, changes } = setup();
    tracker.updateRecords([record("stale", "elite")]);

    tracker.tradeRecorded(trade("stale", "buy", 1));
    await tracker.rateThrough(at(10));

    expect(tracker.summary("m").count).toBe(0);
    expect(changes).toEqual([]);
  });

  it("describes a smart wallet without a cached record by its stats at the buy", async () => {
    const { tracker, changes, stats } = setup();
    stats.set("fresh", GOOD_STATS);

    tracker.tradeRecorded(trade("fresh", "buy", 3));
    await tracker.rateThrough(at(3));

    expect(changes[0]?.wallet.record).toMatchObject({ address: "fresh", tier: "good", tokens: 5, wins: 4, winRate: 80, netPnlSol: 2 });
  });

  it("ignores trades at or after the end of the window, as the close does", async () => {
    const { tracker } = setup();
    tracker.tradeRecorded(trade("good", "buy", 3_600));
    await tracker.rateThrough(at(3_700));

    expect(tracker.summary("m").count).toBe(0);
  });

  it("forgets tokens once closed, without rating their waiting buys again", async () => {
    const { tracker, saved } = setup();
    tracker.tradeRecorded(trade("good", "buy", 1));

    await tracker.rateThrough(null, ["m"]);

    expect(tracker.trackedCount()).toBe(0);
    expect(saved).toEqual([]);
  });

  it("stops counting a wallet as holding after a full sell and reports it once", async () => {
    const { tracker, changes } = setup();
    tracker.tradeRecorded(trade("good", "buy", 1, 1000));
    await tracker.rateThrough(at(1));

    tracker.tradeRecorded(trade("good", "sell", 2, 400));
    tracker.tradeRecorded(trade("good", "sell", 3, 600));
    tracker.tradeRecorded(trade("good", "sell", 4, 1));

    expect(tracker.summary("m")).toEqual({ count: 1, elite: 0, holding: 0, conviction: 1 });
    expect(changes.map((change) => [change.wallet.stillHolding, change.wallet.soldSol])).toEqual([
      [true, 0],
      [false, 1],
    ]);
  });

  it("ignores untracked tokens and forgets tokens after their window once their buys are rated", async () => {
    const { tracker, changes } = setup();
    tracker.tradeRecorded(trade("good", "buy", 1, 1000, "other"));
    tracker.tradeRecorded(trade("good", "buy", 1));
    tracker.tradeRecorded(trade("nobody", "buy", 2));

    tracker.prune(at(3_600 + 1));
    expect(tracker.trackedCount()).toBe(1);
    await tracker.rateThrough(at(2));
    tracker.prune(at(3_600 + 1));

    expect(changes).toHaveLength(1);
    expect(tracker.summary("m")).toEqual({ count: 0, elite: 0, holding: 0, conviction: 0 });
    expect(tracker.trackedCount()).toBe(0);
  });

  it("drops wallets that are no longer good from its records", () => {
    const { tracker } = setup();
    tracker.updateRecords([record("good", "none")]);

    expect(tracker.recordCount()).toBe(2);
  });

  it("gives up on waiting buys one window after the token's window ended", () => {
    const { tracker } = setup();
    tracker.tradeRecorded(trade("good", "buy", 1));

    tracker.prune(at(2 * 3_600 + 1));

    expect(tracker.trackedCount()).toBe(0);
  });

  it("stores each wallet's point-in-time style and counts only conviction wallets as conviction (D7)", async () => {
    const { tracker, saved, stats } = setup();
    stats.set("flipper", { tokens: 10, wins: 10, netPnlSol: 3, flips: 6 }); // 60%
    stats.set("mixed", { tokens: 10, wins: 10, netPnlSol: 3, flips: 4 }); // 40%
    stats.set("steady", { tokens: 10, wins: 10, netPnlSol: 3, flips: 3 }); // 30%

    for (const [index, wallet] of ["flipper", "mixed", "steady", "nobody"].entries()) tracker.tradeRecorded(trade(wallet, "buy", 5 + index));
    await tracker.rateThrough(at(10));

    expect(tracker.summary("m")).toEqual({ count: 3, elite: 0, holding: 3, conviction: 1 });
    expect(saved.map(({ entry }) => [entry.wallet, entry.styleAtEntry])).toEqual([
      ["flipper", "flipper"],
      ["mixed", "mixed"],
      ["steady", "conviction"],
    ]);
  });
});
