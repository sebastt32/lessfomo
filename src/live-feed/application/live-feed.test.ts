import { describe, expect, it } from "vitest";
import type { MomentumSnapshot } from "../../momentum/application/momentum-tracker.js";
import type { Trade } from "../../momentum/domain/trade.js";
import type { ScreeningResult } from "../../screening/token-screener.js";
import type { NewToken } from "../../token-discovery/domain/new-token.js";
import { LiveFeed, type LiveEvent, type LiveTrade } from "./live-feed.js";

const token = (mint: string, detectedAt = new Date("2026-11-13T20:00:00.000Z")): NewToken => ({
  mint,
  name: `Name ${mint}`,
  symbol: mint.toUpperCase(),
  creator: "dev",
  signature: "sig",
  metadataUri: "uri",
  bondingCurve: "curve",
  pool: "pump",
  initialBuyTokens: 0,
  initialBuySol: 0,
  marketCapSol: 28,
  detectedAt,
});

const snapshot = (mint: string, score: number, at: Date): MomentumSnapshot => ({
  mint,
  at,
  momentum: {
    score,
    components: { activity: 0, acceleration: 0, buyPressure: 0 },
    metrics: {
      uniqueBuyers1m: 0,
      uniqueBuyers5m: 0,
      avgUniqueBuyersPrevMinutes: 0,
      buyVolumeSol5m: 0,
      sellVolumeSol5m: 0,
      tradeCount5m: 1,
      medianBuySol5m: 0,
      priceChange5mPct: 0,
      lastPriceSol: null,
    },
  },
});

const AT = new Date("2026-11-13T20:05:00.000Z");

describe("LiveFeed", () => {
  it("starts with no movers and every source connecting", () => {
    const feed = new LiveFeed();

    expect(feed.getMovers(20)).toEqual({ at: null, movers: [] });
    expect(feed.getSources()).toEqual({ pumpportal: "connecting", solanaLogs: "connecting" });
  });

  it("ranks movers by score with their token and safety status", () => {
    const feed = new LiveFeed();
    feed.tokenDetected(token("a"));
    feed.tokenDetected(token("b"));
    const failed: ScreeningResult = {
      token: token("b"),
      status: "failed",
      report: { passed: false, failures: [], metrics: { top10Pct: 0, creatorPct: 0, totalHolders: 1 } },
    };
    feed.screeningFinished(failed, AT);

    feed.momentumUpdated([snapshot("a", 10, AT), snapshot("b", 70, AT)], AT);

    const { at, movers } = feed.getMovers(20);
    expect(at).toEqual(AT);
    expect(movers.map((m) => [m.token.mint, m.status, m.snapshot.momentum.score])).toEqual([
      ["b", "failed", 70],
      ["a", "pending", 10],
    ]);
  });

  it("limits the number of movers returned", () => {
    const feed = new LiveFeed();
    for (const mint of ["a", "b", "c"]) feed.tokenDetected(token(mint));
    feed.momentumUpdated([snapshot("a", 1, AT), snapshot("b", 2, AT), snapshot("c", 3, AT)], AT);

    expect(feed.getMovers(2).movers.map((m) => m.token.mint)).toEqual(["c", "b"]);
  });

  it("skips snapshots of tokens it has never seen", () => {
    const feed = new LiveFeed();

    feed.momentumUpdated([snapshot("ghost", 99, AT)], AT);

    expect(feed.getMovers(20).movers).toEqual([]);
  });

  it("notifies subscribers of every event until they unsubscribe", () => {
    const feed = new LiveFeed();
    const events: LiveEvent["type"][] = [];
    const unsubscribe = feed.subscribe((event) => events.push(event.type));

    feed.tokenDetected(token("a"));
    feed.screeningFinished({ token: token("a"), status: "unverified", reason: "x" }, AT);
    feed.momentumUpdated([snapshot("a", 5, AT)], AT);
    feed.sourceStatusChanged("pumpportal", "connected");
    unsubscribe();
    feed.tokenDetected(token("b"));

    expect(events).toEqual(["token", "screening", "momentum", "status"]);
  });

  it("keeps notifying other subscribers when one throws", () => {
    const feed = new LiveFeed();
    const received: string[] = [];
    feed.subscribe(() => {
      throw new Error("broken client");
    });
    feed.subscribe((event) => received.push(event.type));

    feed.tokenDetected(token("a"));

    expect(received).toEqual(["token"]);
  });

  it("maps socket status messages to source statuses and only notifies on change", () => {
    const feed = new LiveFeed();
    const statuses: unknown[] = [];
    feed.subscribe((event) => {
      if (event.type === "status") statuses.push(event.sources.solanaLogs);
    });

    feed.sourceStatusFromSocket("solanaLogs", "connected");
    feed.sourceStatusFromSocket("solanaLogs", "connected");
    feed.sourceStatusFromSocket("solanaLogs", "error");
    feed.sourceStatusFromSocket("solanaLogs", "disconnected, retrying in 1000ms");

    expect(statuses).toEqual(["connected", "disconnected"]);
    expect(feed.getSources().solanaLogs).toBe("disconnected");
  });

  it("forgets tokens older than the retention window", () => {
    const feed = new LiveFeed();
    feed.tokenDetected(token("old", new Date("2026-11-13T18:00:00.000Z")));
    feed.tokenDetected(token("new", new Date("2026-11-13T20:00:00.000Z")));

    feed.prune(AT, 60 * 60_000);
    feed.momentumUpdated([snapshot("old", 50, AT), snapshot("new", 10, AT)], AT);

    expect(feed.getMovers(20).movers.map((m) => m.token.mint)).toEqual(["new"]);
  });

  describe("trades", () => {
    const trade = (mint: string, trader = "fan"): Trade => ({
      signature: `sig-${mint}-${trader}`,
      mint,
      trader,
      side: "buy",
      solAmount: 0.5,
      tokenAmount: 1000,
      priceSol: 0.0005,
      timestamp: AT,
    });

    it("delivers each trade only to subscribers of its token, flagging the creator's trades", () => {
      const feed = new LiveFeed();
      feed.tokenDetected(token("a"));
      const forA: LiveTrade[] = [];
      const forB: LiveTrade[] = [];
      feed.subscribeTrades("a", (live) => forA.push(live));
      feed.subscribeTrades("b", (live) => forB.push(live));

      feed.tradeRecorded(trade("a"));
      feed.tradeRecorded(trade("a", "dev"));

      expect(forA).toEqual([
        { trade: trade("a"), isDev: false },
        { trade: trade("a", "dev"), isDev: true },
      ]);
      expect(forB).toEqual([]);
    });

    it("does not flag trades of tokens it has never seen as dev trades", () => {
      const feed = new LiveFeed();
      const received: LiveTrade[] = [];
      feed.subscribeTrades("ghost", (live) => received.push(live));

      feed.tradeRecorded(trade("ghost", "dev"));

      expect(received).toEqual([{ trade: trade("ghost", "dev"), isDev: false }]);
    });

    it("keeps notifying other trade subscribers when one throws", () => {
      const feed = new LiveFeed();
      const received: string[] = [];
      feed.subscribeTrades("a", () => {
        throw new Error("broken client");
      });
      feed.subscribeTrades("a", (live) => received.push(live.trade.signature));

      feed.tradeRecorded(trade("a"));

      expect(received).toEqual(["sig-a-fan"]);
    });

    it("stops delivering after unsubscribe and leaves no subscription behind", () => {
      const feed = new LiveFeed();
      const received: string[] = [];
      const first = feed.subscribeTrades("a", (live) => received.push(live.trade.signature));
      const second = feed.subscribeTrades("a", () => {});

      first();
      first();
      feed.tradeRecorded(trade("a"));
      second();

      expect(received).toEqual([]);
      expect(feed.tradeSubscriptionCount()).toBe(0);
    });

    it("does not send trades to general event subscribers", () => {
      const feed = new LiveFeed();
      const events: LiveEvent[] = [];
      feed.subscribe((event) => events.push(event));

      feed.tradeRecorded(trade("a"));

      expect(events).toEqual([]);
    });
  });
});
