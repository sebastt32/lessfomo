import { afterEach, describe, expect, it } from "vitest";
import { SqliteHistoryRecorder } from "../../history/infrastructure/sqlite/sqlite-history-recorder.js";
import type { Trade } from "../../momentum/domain/trade.js";
import type { NewToken } from "../../token-discovery/domain/new-token.js";
import type { MarketQuote } from "../domain/assemble-snapshot.js";
import type { MarketDataSource } from "../domain/market-data-source.js";
import { SnapshotScheduler, type HolderJob, type HolderRequester } from "./snapshot-scheduler.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const T0 = new Date("2026-11-14T00:00:00.000Z").getTime();

const token = (mint: string, overrides: Partial<NewToken> = {}): NewToken => ({
  mint,
  name: `Name ${mint}`,
  symbol: mint.toUpperCase(),
  creator: "dev",
  signature: "sig",
  metadataUri: "https://example.com/meta.json",
  bondingCurve: `curve-${mint}`,
  pool: "pump",
  initialBuyTokens: 0,
  initialBuySol: 0.5,
  marketCapSol: 30,
  detectedAt: new Date(T0),
  ...overrides,
});

let sequence = 0;
const trade = (mint: string, atMs: number, overrides: Partial<Trade> = {}): Trade => {
  sequence += 1;
  return {
    signature: `sig${sequence}`,
    mint,
    trader: `wallet${sequence}`,
    side: "buy",
    solAmount: 1,
    tokenAmount: 1000,
    priceSol: 0.00000003,
    timestamp: new Date(atMs),
    curve: { realSolReserves: 5, progressPct: 10, complete: false },
    ...overrides,
  };
};

const quote = (overrides: Partial<MarketQuote> = {}): MarketQuote => ({
  priceSol: 0.0000001,
  liquiditySol: null,
  migrated: false,
  windows: {
    m5: { volumeSol: 1, buys: 1, sells: 0 },
    h1: { volumeSol: 10, buys: 10, sells: 5 },
    h6: { volumeSol: 60, buys: 60, sells: 30 },
    h24: { volumeSol: 240, buys: 240, sells: 120 },
  },
  ...overrides,
});

class FakeMarketData implements MarketDataSource {
  readonly requests: string[][] = [];
  quotesByMint = new Map<string, MarketQuote>();
  async quotes(mints: readonly string[]): Promise<Map<string, MarketQuote>> {
    this.requests.push([...mints]);
    return new Map(mints.flatMap((mint) => (this.quotesByMint.has(mint) ? [[mint, this.quotesByMint.get(mint)!]] : [])));
  }
}

class FakeHolders implements HolderRequester {
  readonly jobs: HolderJob[] = [];
  request(job: HolderJob): void {
    this.jobs.push(job);
  }
  stop(): void {}
}

const stores: SqliteHistoryRecorder[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

const setup = (options: { store?: SqliteHistoryRecorder; quoteLimit?: number } = {}) => {
  const store = options.store ?? new SqliteHistoryRecorder(":memory:");
  if (options.store === undefined) stores.push(store);
  const market = new FakeMarketData();
  const holders = new FakeHolders();
  let now = T0;
  const scheduler = new SnapshotScheduler({
    store,
    marketData: market,
    holders,
    trackingWindowMs: HOUR,
    clock: () => new Date(now),
    ...(options.quoteLimit !== undefined && { quoteLimit: options.quoteLimit }),
  });
  /** Detects a token like the pipeline does: stored first, then watched. */
  const detect = async (t: NewToken) => {
    await store.recordToken(t);
    scheduler.tokenDetected(t);
  };
  /** Records a trade like the pipeline does while the token is tracked. */
  const tradeLive = async (t: Trade) => {
    scheduler.tradeObserved(t);
    await store.recordTrade(t);
  };
  const at = async (ms: number) => {
    now = T0 + ms;
    await scheduler.tick();
  };
  const snapshots = async (mint: string) => (await store.tokenSnapshots(mint, new Date(now)))?.snapshots ?? [];
  return { store, market, holders, scheduler, detect, tradeLive, at, snapshots };
};

describe("SnapshotScheduler", () => {
  it("takes the 0m snapshot right after creation, from stored trades and the latest curve liquidity", async () => {
    const { detect, tradeLive, at, snapshots, store } = setup();
    await detect(token("a"));
    await tradeLive(trade("a", T0 + 1_000, { solAmount: 0.5, priceSol: 0.00000003 }));

    await at(5_000);

    expect(await snapshots("a")).toEqual([
      {
        mint: "a",
        milestone: "0m",
        at: new Date(T0 + 5_000),
        priceSol: 0.00000003,
        marketCapSol: 30,
        volumeSol: 0.5,
        buys: 1,
        sells: 0,
        uniqueBuyers: 1,
        holders: null,
        top10Pct: null,
        devHoldsPct: null,
        liquidity: { sol: 5, bondingCurvePct: 10, migrated: false },
        source: "trades",
      },
    ]);
    expect((await store.dueTokens(new Date(T0 + MINUTE), 10)).map((d) => d.nextMilestone)).toEqual(["1m"]);
  });

  it("counts only the trades since the previous snapshot and persists the latest market state", async () => {
    const { detect, tradeLive, at, snapshots, store } = setup();
    await detect(token("a"));
    await tradeLive(trade("a", T0 + 1_000));
    await at(5_000);
    await tradeLive(trade("a", T0 + 20_000, { side: "sell", solAmount: 2 }));
    await tradeLive(
      trade("a", T0 + 40_000, { solAmount: 3, priceSol: 0.00000005, curve: { realSolReserves: 9, progressPct: 20, complete: false } }),
    );

    await at(MINUTE + 2_000);

    expect((await snapshots("a"))[1]).toMatchObject({
      milestone: "1m",
      volumeSol: 5,
      buys: 1,
      sells: 1,
      uniqueBuyers: 1,
      priceSol: 0.00000005,
      liquidity: { sol: 9, bondingCurvePct: 20, migrated: false },
    });
    expect((await store.listTokens(listQuery(T0 + MINUTE))).tokens[0]).toMatchObject({
      liquidity: { sol: 9, bondingCurvePct: 20, migrated: false },
      lastPriceSol: 0.00000005,
      lastTradeAt: new Date(T0 + 40_000),
    });
  });

  it("waits 5 seconds after creation for the creation trade to arrive before taking 0m", async () => {
    const { detect, scheduler, tradeLive, at, snapshots } = setup();
    await detect(token("a"));

    await at(4_000);
    await tradeLive(trade("a", T0 - 1_000, { curve: { realSolReserves: 2, progressPct: 1.5, complete: false } }));
    expect(await snapshots("a")).toEqual([]);
    await at(5_000);

    expect((await snapshots("a"))[0]).toMatchObject({ milestone: "0m", liquidity: { sol: 2, bondingCurvePct: 1.5 } });
    expect(scheduler.watchedCount()).toBe(1);
  });

  it("uses the creation price when no trade was seen yet", async () => {
    const { detect, at, snapshots } = setup();
    await detect(token("a", { marketCapSol: 28 }));

    await at(5_000);

    expect((await snapshots("a"))[0]).toMatchObject({ priceSol: 0.000000028, marketCapSol: 28, volumeSol: 0 });
  });

  it("seeds the liquidity of a token from a trade seen just before the token was detected", async () => {
    const { detect, scheduler, at, snapshots } = setup();
    scheduler.tradeObserved(trade("a", T0 - 500, { curve: { realSolReserves: 1.2, progressPct: 3.5, complete: false } }));
    await detect(token("a"));

    await at(5_000);

    expect((await snapshots("a"))[0]?.liquidity).toEqual({ sol: 1.2, bondingCurvePct: 3.5, migrated: false });
  });

  it("switches to DexScreener after the live window, in batches bounded per tick", async () => {
    const { detect, market, at, snapshots, store } = setup({ quoteLimit: 2 });
    for (const mint of ["a", "b", "c"]) await detect(token(mint));
    market.quotesByMint.set("a", quote());
    market.quotesByMint.set("b", quote());
    market.quotesByMint.set("c", quote());
    // Restarted after 2 hours: every token goes straight to its latest due milestone.
    await store.updateMarkets(
      ["a", "b", "c"].map((mint) => ({
        mint,
        lastPriceSol: null,
        lastTradeAt: null,
        lastActivityAt: new Date(T0 + 90 * MINUTE),
        peakPriceSol: 0.0000002,
        liquidity: { sol: 30, bondingCurvePct: 55, migrated: false },
      })),
    );

    await at(2 * HOUR + 1_000);

    expect(market.requests).toEqual([["a", "b"]]);
    expect(await snapshots("a")).toEqual([
      expect.objectContaining({
        milestone: "2h",
        at: new Date(T0 + 2 * HOUR + 1_000),
        priceSol: 0.0000001,
        marketCapSol: 100,
        volumeSol: null,
        liquidity: { sol: 30, bondingCurvePct: 55, migrated: false },
        source: "mixed",
      }),
    ]);
    expect(await snapshots("c")).toEqual([]);

    await at(2 * HOUR + 6_000);

    expect(market.requests[1]).toEqual(["c"]);
    expect((await snapshots("c"))[0]?.milestone).toBe("2h");
  });

  it("takes only the latest missed milestone after a restart and resumes the schedule from there", async () => {
    const store = new SqliteHistoryRecorder(":memory:");
    stores.push(store);
    const before = setup({ store });
    await before.detect(token("a"));
    await before.tradeLive(trade("a", T0 + 1_000));
    await before.at(5_000);
    await before.scheduler.stop();

    const after = setup({ store });
    await after.scheduler.restore();
    await after.tradeLive(trade("a", T0 + 16 * MINUTE));
    await after.at(17 * MINUTE);

    expect((await after.snapshots("a")).map((s) => [s.milestone, s.at.getTime() - T0])).toEqual([
      ["0m", 5_000],
      ["15m", 17 * MINUTE],
    ]);
    expect((await store.dueTokens(new Date(T0 + 30 * MINUTE), 10))[0]?.nextMilestone).toBe("30m");
  });

  it("stops the schedule of a token without trades for 24 hours", async () => {
    const { detect, tradeLive, market, at, snapshots, store } = setup();
    await detect(token("a"));
    await tradeLive(trade("a", T0 + 1_000));
    await at(5_000);

    await at(DAY + 5 * MINUTE);

    expect((await snapshots("a")).map((s) => s.milestone)).toEqual(["0m"]);
    expect(market.requests).toEqual([["a"]]);
    expect(await store.dueTokens(new Date(T0 + 30 * DAY), 10)).toEqual([]);
    expect((await store.tokenSnapshots("a", new Date(T0 + DAY)))?.lifecycle).toBe("dead");
  });

  it("keeps a token alive while DexScreener reports trades in the last 24 hours", async () => {
    const { detect, market, at, snapshots } = setup();
    await detect(token("a"));
    await at(5_000);
    market.quotesByMint.set("a", quote({ liquiditySol: 80, migrated: true }));

    await at(DAY + 5 * MINUTE);

    expect((await snapshots("a")).find((s) => s.milestone === "24h")).toMatchObject({
      liquidity: { sol: 80, bondingCurvePct: 100, migrated: true },
      source: "dexscreener",
    });
  });

  it("takes an event:migrated snapshot when the curve completes, once", async () => {
    const { detect, tradeLive, at, snapshots, store } = setup();
    await detect(token("a"));
    await at(5_000);
    await tradeLive(trade("a", T0 + 3 * MINUTE, { curve: { realSolReserves: 85, progressPct: 100, complete: true } }));

    await at(3 * MINUTE + 1_000);
    await at(3 * MINUTE + 6_000);

    expect((await snapshots("a")).map((s) => s.milestone)).toEqual(["0m", "1m", "event:migrated"]);
    expect((await snapshots("a"))[2]).toMatchObject({ liquidity: { sol: 85, bondingCurvePct: 100, migrated: true } });
    expect((await store.stats(new Date(T0 + 4 * MINUTE))).tokens.migrated).toBe(1);
  });

  it("takes at most one event:new-peak per milestone window", async () => {
    const { detect, tradeLive, at, snapshots } = setup();
    await detect(token("a"));
    await at(5_000);
    await tradeLive(trade("a", T0 + 10_000, { priceSol: 0.0000001 }));
    await at(15_000);
    await tradeLive(trade("a", T0 + 20_000, { priceSol: 0.0000002 }));
    await at(25_000);
    await at(MINUTE + 1_000);
    await tradeLive(trade("a", T0 + MINUTE + 2_000, { priceSol: 0.0000003 }));
    await at(MINUTE + 5_000);
    await tradeLive(trade("a", T0 + MINUTE + 6_000, { priceSol: 0.00000001 }));
    await at(MINUTE + 10_000);

    expect((await snapshots("a")).map((s) => [s.milestone, s.priceSol])).toEqual([
      ["0m", 0.00000003],
      ["event:new-peak", 0.0000001],
      ["1m", 0.0000002],
      ["event:new-peak", 0.0000003],
    ]);
  });

  it("skips a new peak already captured by the scheduled snapshot of the same tick", async () => {
    const { detect, tradeLive, at, snapshots } = setup();
    await detect(token("a"));
    await tradeLive(trade("a", T0 + 1_000, { priceSol: 0.0000001 }));

    await at(5_000);
    await tradeLive(trade("a", T0 + 20_000, { priceSol: 0.0000002 }));
    await at(25_000);

    expect((await snapshots("a")).map((s) => [s.milestone, s.priceSol])).toEqual([
      ["0m", 0.0000001],
      ["event:new-peak", 0.0000002],
    ]);
  });

  it("asks for holders only for survivors, from the 1h milestone on", async () => {
    const { detect, tradeLive, holders, at } = setup();
    await detect(token("a"));
    await at(5_000);
    await tradeLive(trade("a", T0 + 59 * MINUTE));

    await at(30 * MINUTE + 1_000);
    await at(HOUR + 1_000);

    expect(holders.jobs).toEqual([
      expect.objectContaining({
        token: expect.objectContaining({ mint: "a", bondingCurve: "curve-a", creator: "dev" }),
        snapshot: expect.objectContaining({ milestone: "1h", at: new Date(T0 + HOUR + 1_000) }),
        holderThreshold: 0,
      }),
    ]);
  });

  it("tells its listener about every snapshot it stores, after storing it", async () => {
    const { detect, tradeLive, at, scheduler, store } = setup();
    const saved: string[] = [];
    scheduler.onSnapshotSaved((snapshot) => {
      const stored = store.query("SELECT COUNT(*) AS n FROM token_snapshots WHERE mint = ? AND milestone = ?", snapshot.mint, snapshot.milestone);
      saved.push(`${snapshot.mint}:${snapshot.milestone}:${String(stored[0]?.["n"])}`);
    });
    await detect(token("a"));
    await tradeLive(trade("a", T0 + 1_000));

    await at(5_000);
    await at(MINUTE);

    expect(saved).toEqual(["a:0m:1", "a:1m:1"]);
  });
});

const listQuery = (nowMs: number) => ({
  from: null,
  to: null,
  statuses: [],
  lifecycle: null,
  minScore: null,
  search: null,
  sort: { field: "detectedAt" as const, direction: "desc" as const },
  page: 1,
  pageSize: 50,
  now: new Date(nowMs),
});
