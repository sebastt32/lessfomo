import { describe, expect, it } from "vitest";
import type { Trade } from "../../momentum/domain/trade.js";
import type { WalletRecord, WalletTier } from "../domain/reputation-rules.js";
import type { SmartWalletEntry } from "../domain/wallet-reputation-store.js";
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

const setup = () => {
  const changes: SmartWalletChange[] = [];
  const saved: { mint: string; entry: SmartWalletEntry }[] = [];
  const tracker = new SmartWalletTracker({
    trackingWindowMs: 3_600_000,
    onChange: (change) => changes.push(change),
    persist: (mint, entry) => saved.push({ mint, entry }),
  });
  tracker.updateRecords([record("good", "good"), record("elite", "elite"), record("dev", "elite")]);
  tracker.track({ mint: "m", creator: "dev", detectedAt: DETECTED });
  return { tracker, changes, saved };
};

describe("SmartWalletTracker", () => {
  it("counts good and elite wallets at their first buy and reports each one", () => {
    const { tracker, changes, saved } = setup();

    tracker.tradeRecorded(trade("good", "buy", 5));
    tracker.tradeRecorded(trade("nobody", "buy", 6));
    tracker.tradeRecorded(trade("elite", "buy", 7));

    expect(tracker.summary("m")).toEqual({ count: 2, elite: 1, holding: 2 });
    expect(changes.map((change) => [change.wallet.wallet, change.smartWallets])).toEqual([
      ["good", { count: 1, elite: 0, holding: 1 }],
      ["elite", { count: 2, elite: 1, holding: 2 }],
    ]);
    expect(changes[0]?.wallet).toEqual({
      wallet: "good",
      tierAtEntry: "good",
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

  it("never counts the token creator, even when it is elite", () => {
    const { tracker, changes } = setup();

    tracker.tradeRecorded(trade("dev", "buy", 1));

    expect(tracker.summary("m")).toEqual({ count: 0, elite: 0, holding: 0 });
    expect(changes).toEqual([]);
  });

  it("keeps the tier of the first buy fixed when the wallet's record changes later", () => {
    const { tracker } = setup();
    tracker.tradeRecorded(trade("good", "buy", 1));

    tracker.updateRecords([record("good", "elite")]);
    tracker.tradeRecorded(trade("good", "buy", 2));

    expect(tracker.summary("m")).toEqual({ count: 1, elite: 0, holding: 1 });
  });

  it("ignores a wallet whose first buy came before it was good", () => {
    const { tracker } = setup();
    tracker.tradeRecorded(trade("later", "buy", 1));

    tracker.updateRecords([record("later", "good")]);
    tracker.tradeRecorded(trade("later", "buy", 2));

    expect(tracker.summary("m").count).toBe(0);
  });

  it("stops counting a wallet as holding after a full sell and reports it once", () => {
    const { tracker, changes } = setup();
    tracker.tradeRecorded(trade("good", "buy", 1, 1000));

    tracker.tradeRecorded(trade("good", "sell", 2, 400));
    tracker.tradeRecorded(trade("good", "sell", 3, 600));
    tracker.tradeRecorded(trade("good", "sell", 4, 1));

    expect(tracker.summary("m")).toEqual({ count: 1, elite: 0, holding: 0 });
    expect(changes.map((change) => [change.wallet.stillHolding, change.wallet.soldSol])).toEqual([
      [true, 0],
      [false, 1],
    ]);
  });

  it("ignores untracked tokens and forgets tokens after their window", () => {
    const { tracker, changes } = setup();
    tracker.tradeRecorded(trade("good", "buy", 1, 1000, "other"));
    tracker.tradeRecorded(trade("good", "buy", 1));

    tracker.prune(at(3_600 + 1));

    expect(changes).toHaveLength(1);
    expect(tracker.summary("m")).toEqual({ count: 0, elite: 0, holding: 0 });
    expect(tracker.trackedCount()).toBe(0);
  });

  it("drops wallets that are no longer good from its records", () => {
    const { tracker } = setup();
    tracker.updateRecords([record("good", "none")]);

    tracker.tradeRecorded(trade("good", "buy", 1));

    expect(tracker.summary("m").count).toBe(0);
    expect(tracker.recordCount()).toBe(2);
  });
});
