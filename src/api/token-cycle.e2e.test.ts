import type { AddressInfo } from "node:net";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createTestSession } from "../auth/testing/signed-in.js";
import { loadAppConfig } from "../config/app-config.js";
import { ConfigModule } from "../config/config.module.js";
import { HISTORY_STORE } from "../history/history.module.js";
import { SqliteHistoryRecorder } from "../history/infrastructure/sqlite/sqlite-history-recorder.js";
import { LiveFeed } from "../live-feed/application/live-feed.js";
import { LIVE_FEED } from "../live-feed/live-feed.module.js";
import { SOL_USD_PRICE } from "../market-price/market-price.module.js";
import type { MomentumSnapshot } from "../momentum/application/momentum-tracker.js";
import type { Trade } from "../momentum/domain/trade.js";
import type { NewToken } from "../token-discovery/domain/new-token.js";
import { advanceCycle, DEFAULT_CYCLE_RULES, startCycle, summarizeCycle, tradePoints, type CycleState } from "../token-cycle/domain/token-cycle.js";
import type { SmartWalletEntry, SmartWalletInToken } from "../wallet-reputation/domain/wallet-reputation-store.js";
import { ApiModule } from "./api.module.js";
import { API_ERROR_REPORTER } from "./http/api-exception.filter.js";
import { API_APPLICATION_OPTIONS, createApiHttpAdapter } from "./http/api-http-adapter.js";

/** Base58 addresses of 44 characters. */
const address = (prefix: string) => `${prefix}${"1".repeat(44 - prefix.length)}`;
const CRASHED = address("Crashed");
const LATE = address("Late");
const FRESH = address("Fresh");
const HIDDEN = address("Hidden");
const LIVE = address("Live");

/** Two hours ago, on a whole second. */
const T0 = Math.floor(Date.now() / 1000) * 1000 - 2 * 3_600_000;
const at = (seconds: number): Date => new Date(T0 + seconds * 1000);
const iso = (seconds: number): string => at(seconds).toISOString();
const UPDATED_AT = at(900);

const token = (mint: string, detectedSeconds: number): NewToken => ({
  mint,
  name: `Name ${mint.slice(0, 4)}`,
  symbol: mint.slice(0, 4).toUpperCase(),
  creator: "dev",
  signature: "sig",
  metadataUri: "",
  bondingCurve: "curve",
  pool: "pump",
  initialBuyTokens: 0,
  initialBuySol: 0,
  marketCapSol: 30,
  detectedAt: at(detectedSeconds),
});

const wallet = (name: string, seconds: number): SmartWalletEntry => ({
  wallet: name,
  tierAtEntry: "good",
  styleAtEntry: "conviction",
  firstBuyAt: at(seconds),
  entrySeconds: seconds,
  boughtSol: 1,
  soldSol: 0,
  stillHolding: true,
});

/** The cycle of a token that appeared 100 s in, after these `[seconds, price]` trades. */
const cycleAfter = (...points: [number, number][]): CycleState =>
  advanceCycle(startCycle(at(100)), tradePoints(points.map(([seconds, priceSol]) => ({ at: at(seconds), priceSol }))), DEFAULT_CYCLE_RULES);

const CRASHED_STATE = cycleAfter([0, 1], [100, 1.6], [130, 1.8], [200, 3.2], [300, 6.4], [330, 3.2]);
const LATE_STATE = cycleAfter([0, 1], [40, 2], [100, 2.4]);
const HIDDEN_STATE = cycleAfter([0, 8], [100, 10], [110, 20]);

const CRASHED_VIEW = {
  appearedAt: iso(100),
  launchPriceSol: 1,
  appearedPriceSol: 1.6,
  riseBeforeAppearanceX: 1.6,
  appearedLate: false,
  phase: "crashed",
  runStartAt: iso(130),
  explosionAt: iso(200),
  investWindowSeconds: 30,
  peakAt: iso(300),
  peakX: 4,
  crashAt: iso(330),
  maxDrawdownPct: 50,
  lastPriceX: 2,
  updatedAt: UPDATED_AT.toISOString(),
};
const LATE_VIEW = {
  appearedAt: iso(100),
  launchPriceSol: 1,
  appearedPriceSol: 2.4,
  riseBeforeAppearanceX: 2.4,
  appearedLate: true,
  phase: "stable",
  runStartAt: null,
  explosionAt: null,
  investWindowSeconds: -60,
  peakAt: null,
  peakX: null,
  crashAt: null,
  maxDrawdownPct: null,
  lastPriceX: 1,
  updatedAt: UPDATED_AT.toISOString(),
};

/** Every request of this file is made by a signed-in session (docs/API.md "Authentication"). */
const session = createTestSession();
const fetch = session.fetch;

let app: INestApplication | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

/**
 * Public tokens need two conviction wallets. CRASHED and LATE have them and a stored cycle; FRESH
 * has them but no cycle yet; HIDDEN has a cycle but only one conviction wallet left.
 */
const start = async () => {
  const history = new SqliteHistoryRecorder(":memory:");
  for (const [index, mint] of [CRASHED, LATE, FRESH, HIDDEN].entries()) {
    await history.recordToken(token(mint, -index));
    await history.recordScreening({ token: token(mint, -index), status: "unverified", reason: "test" }, at(60 + index));
    await history.saveSmartWallet(mint, wallet("w1", 40));
    if (mint !== HIDDEN) await history.saveSmartWallet(mint, wallet("w2", 100));
  }
  for (const [mint, state] of [[CRASHED, CRASHED_STATE], [LATE, LATE_STATE], [HIDDEN, HIDDEN_STATE]] as const) {
    await history.createCycle(mint, at(100), UPDATED_AT);
    await history.saveCycle(mint, state, true, UPDATED_AT);
  }

  const feed = new LiveFeed(2);
  const config = loadAppConfig({ PUBLIC_MIN_CONVICTION_WALLETS: "2" }, new Date());
  const moduleRef = await session
    .signIn(Test.createTestingModule({ imports: [ConfigModule.forRoot(config), ApiModule] }))
    .overrideProvider(LIVE_FEED)
    .useValue(feed)
    .overrideProvider(HISTORY_STORE)
    .useValue({ history, description: "sqlite" })
    .overrideProvider(SOL_USD_PRICE)
    .useValue({ current: () => null, subscribe: () => () => undefined })
    .overrideProvider(API_ERROR_REPORTER)
    .useValue(() => undefined)
    .compile();
  app = moduleRef.createNestApplication(createApiHttpAdapter(), API_APPLICATION_OPTIONS);
  await app.listen(0, "127.0.0.1");
  const { port } = app.getHttpServer().address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const get = async (path: string) => {
    const response = await fetch(`${base}${path}`);
    return { status: response.status, body: await response.json() };
  };
  const mints = async (query: string): Promise<string[]> =>
    (await get(`/api/tokens?${query}`)).body.tokens.map((item: { token: { mint: string } }) => item.token.mint);
  return { feed, history, get, mints, base };
};

const readSse = async (response: Response, until: (text: string) => boolean): Promise<string> => {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!until(text)) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  await reader.cancel();
  return text;
};

const eventData = (text: string, name: string): unknown[] =>
  [...text.matchAll(new RegExp(`event: ${name}\\ndata: (.*)\\n`, "g"))].map((match) => JSON.parse(match[1] ?? "null"));

/** Two conviction wallets buy the token live: it is public from now on. */
const qualify = (feed: LiveFeed, mint: string): void =>
  feed.smartWalletChanged({
    mint,
    smartWallets: { count: 2, elite: 0, holding: 2, conviction: 2 },
    wallet: {
      ...wallet("w2", 100),
      record: {
        address: "w2",
        tier: "good",
        isBot: false,
        tokens: 5,
        wins: 4,
        winRate: 80,
        netPnlSol: 2,
        avgPnlSol: 0.4,
        medianEntrySeconds: 12,
        style: "conviction",
        flipRate: 0,
        medianHoldSeconds: 300,
        lastActiveAt: null,
        updatedAt: at(0),
      },
    } satisfies SmartWalletInToken,
  });

const momentum = (mint: string): MomentumSnapshot => ({
  mint,
  at: at(300),
  momentum: {
    score: 21,
    components: { activity: 0.24, acceleration: 1, buyPressure: 0.6 },
    metrics: {
      uniqueBuyers1m: 5,
      uniqueBuyers5m: 12,
      avgUniqueBuyersPrevMinutes: 1.75,
      buyVolumeSol5m: 2,
      sellVolumeSol5m: 0.5,
      tradeCount5m: 20,
      medianBuySol5m: 0.1,
      priceChange5mPct: 12.5,
      lastPriceSol: 0.00003,
    },
  },
});

const liveTrade: Trade = {
  signature: "tradeSig",
  mint: LIVE,
  trader: "fan",
  side: "buy",
  solAmount: 0.25,
  tokenAmount: 9000,
  priceSol: 0.00003,
  timestamp: at(120),
};

describe("token cycle API", () => {
  it("adds the cycle to a token's detail, or null when it has none yet", async () => {
    const { get } = await start();

    const crashed = (await get(`/api/tokens/${CRASHED}`)).body;
    expect(crashed.cycle).toEqual(CRASHED_VIEW);
    expect(Object.keys(crashed)).toEqual(["token", "status", "screenings", "momentum", "cycle"]);
    expect((await get(`/api/tokens/${LATE}`)).body.cycle).toEqual(LATE_VIEW);
    expect((await get(`/api/tokens/${FRESH}`)).body.cycle).toBeNull();
  });

  it("adds the cycle to every listed token and screening", async () => {
    const { get } = await start();

    const { tokens, total } = (await get("/api/tokens")).body;
    expect(total).toBe(3);
    expect(tokens.map((item: { token: { mint: string }; cycle: unknown }) => [item.token.mint, item.cycle])).toEqual([
      [CRASHED, CRASHED_VIEW],
      [LATE, LATE_VIEW],
      [FRESH, null],
    ]);

    const { screenings } = (await get("/api/screenings")).body;
    expect(screenings.map((screening: { mint: string; cycle: unknown }) => [screening.mint, screening.cycle])).toEqual([
      [FRESH, null],
      [LATE, LATE_VIEW],
      [CRASHED, CRASHED_VIEW],
    ]);
    expect((await get(`/api/tokens/${CRASHED}`)).body.screenings[0].cycle).toEqual(CRASHED_VIEW);
    expect((await get(`/api/tokens/${FRESH}`)).body.screenings[0].cycle).toBeNull();
  });

  it("filters the token list by phase and by late appearance", async () => {
    const { mints, get } = await start();

    expect(await mints("phase=crashed")).toEqual([CRASHED]);
    expect(await mints("phase=stable,exploding")).toEqual([LATE]);
    expect(await mints("phase=stable,crashed")).toEqual([CRASHED, LATE]);
    expect(await mints("appearedLate=true")).toEqual([LATE]);
    expect(await mints("appearedLate=false")).toEqual([CRASHED]);
    expect(await mints("phase=crashed&appearedLate=true")).toEqual([]);
    expect((await get("/api/tokens?phase=exploding")).body).toEqual({ tokens: [], page: 1, pageSize: 50, total: 0 });
  });

  it("sorts the token list by appearance and by invest window, tokens without one last", async () => {
    const { mints, history } = await start();
    await history.createCycle(FRESH, at(500), UPDATED_AT);

    expect(await mints("sort=appearedAt:desc")).toEqual([FRESH, CRASHED, LATE]);
    expect(await mints("sort=appearedAt:asc")).toEqual([CRASHED, LATE, FRESH]);
    expect(await mints("sort=appearedAt")).toEqual([FRESH, CRASHED, LATE]);
    expect(await mints("sort=investWindow:desc")).toEqual([CRASHED, LATE, FRESH]);
    expect(await mints("sort=investWindow:asc")).toEqual([LATE, CRASHED, FRESH]);
  });

  it("answers 400 INVALID_QUERY for a bad phase, lateness or sort", async () => {
    const { get } = await start();

    for (const [query, parameter] of [
      ["phase=mooning", "phase"],
      ["phase=stable,", "phase"],
      ["phase=", "phase"],
      ["appearedLate=yes", "appearedLate"],
      ["appearedLate=1", "appearedLate"],
      ["appearedLate=", "appearedLate"],
      ["sort=investWindow:up", "sort"],
      ["sort=appearedAt:asc:desc", "sort"],
      ["sort=window", "sort"],
    ] as const) {
      const { status, body } = await get(`/api/tokens?${query}`);
      expect([query, status, body.error.code]).toEqual([query, 400, "INVALID_QUERY"]);
      expect(body.error.message).toContain(`"${parameter}"`);
    }
  });

  it("keeps a token that is no longer public hidden, even with a stored cycle", async () => {
    const { get, mints } = await start();

    expect(await get(`/api/tokens/${HIDDEN}`)).toEqual({ status: 404, body: { error: { code: "TOKEN_NOT_FOUND", message: "Token was never seen" } } });
    expect(await mints("phase=exploding")).toEqual([]);
    expect(await mints("sort=appearedAt:desc")).not.toContain(HIDDEN);
    expect((await get("/api/screenings")).body.screenings.map((s: { mint: string }) => s.mint)).not.toContain(HIDDEN);
  });

  it("shows the cycle with live movers", async () => {
    const { feed, get } = await start();
    feed.tokenDetected(token(LIVE, 0));
    qualify(feed, LIVE);
    feed.momentumUpdated([momentum(LIVE)], at(300));
    expect((await get("/api/movers")).body.movers.map((mover: { cycle: unknown }) => mover.cycle)).toEqual([null]);

    feed.cycleUpdated(LIVE, summarizeCycle(CRASHED_STATE, UPDATED_AT));

    expect((await get("/api/movers")).body.movers.map((mover: { mint: string; cycle: unknown }) => [mover.mint, mover.cycle])).toEqual([[LIVE, CRASHED_VIEW]]);
  });

  it("streams cycle events, and the cycle inside screening and momentum events, on /api/stream", async () => {
    const { feed, base } = await start();
    const response = await fetch(`${base}/api/stream`);
    setTimeout(() => {
      feed.tokenDetected(token(LIVE, 0));
      qualify(feed, LIVE);
      feed.cycleChanged(LIVE, summarizeCycle(LATE_STATE, UPDATED_AT));
      feed.screeningFinished({ token: token(LIVE, 0), status: "unverified", reason: "test" }, at(200));
      feed.cycleChanged(LIVE, summarizeCycle(CRASHED_STATE, UPDATED_AT));
      feed.momentumUpdated([momentum(LIVE)], at(300));
    }, 20);

    const text = await readSse(response, (t) => t.includes("event: momentum"));

    expect(eventData(text, "cycle")).toEqual([
      { mint: LIVE, cycle: LATE_VIEW },
      { mint: LIVE, cycle: CRASHED_VIEW },
    ]);
    expect(eventData(text, "screening")).toEqual([expect.objectContaining({ mint: LIVE, cycle: LATE_VIEW })]);
    expect((eventData(text, "momentum")[0] as { movers: { cycle: unknown }[] }).movers.map((mover) => mover.cycle)).toEqual([CRASHED_VIEW]);
    // The order clients see: token, smart wallet, then its cycle.
    expect(text.indexOf("event: token")).toBeLessThan(text.indexOf("event: cycle"));
  });

  it("streams a token's cycle events on its own stream only, once it is public", async () => {
    const { feed, base } = await start();
    feed.tokenDetected(token(LIVE, 0));
    const response = await fetch(`${base}/api/tokens/${LIVE}/stream`);
    const other = await fetch(`${base}/api/tokens/${FRESH}/stream`);
    setTimeout(() => {
      // Not public yet: nothing is sent.
      feed.cycleChanged(LIVE, summarizeCycle(LATE_STATE, UPDATED_AT));
      qualify(feed, LIVE);
      feed.cycleChanged(LIVE, summarizeCycle(CRASHED_STATE, UPDATED_AT));
      feed.cycleChanged(FRESH, summarizeCycle(LATE_STATE, UPDATED_AT));
      feed.tradeRecorded(liveTrade);
    }, 20);

    const text = await readSse(response, (t) => t.includes("event: trade"));
    const otherText = await readSse(other, (t) => t.includes("event: cycle"));

    expect(eventData(text, "cycle")).toEqual([{ mint: LIVE, cycle: CRASHED_VIEW }]);
    expect(eventData(otherText, "cycle")).toEqual([{ mint: FRESH, cycle: LATE_VIEW }]);
  });

  describe("GET /api/analysis/cycles", () => {
    it("aggregates the cycles that appeared in the last 7 days by default", async () => {
      const { get } = await start();

      const { status, body } = await get("/api/analysis/cycles");

      expect(status).toBe(200);
      expect(new Date(body.to).getTime() - new Date(body.from).getTime()).toBe(7 * 24 * 3_600_000);
      // CRASHED (window 30 s, peak 4× after 200 s, crash 30 s later), LATE (−60 s) and HIDDEN (window 0, peak 2× after 10 s).
      expect({ ...body, from: "", to: "" }).toEqual({
        from: "",
        to: "",
        tokens: 3,
        appearedInTimePct: 66.67,
        appearedLatePct: 33.33,
        explodedPct: 66.67,
        neverExplodedPct: 33.33,
        crashedPct: 33.33,
        medianInvestWindowSeconds: 15,
        medianPeakX: 3,
        medianSecondsToPeak: 105,
        medianSecondsPeakToCrash: 30,
        windowBuckets: [
          { label: "late", tokens: 1, medianPeakX: null },
          { label: "<1m", tokens: 2, medianPeakX: 3 },
          { label: "1-5m", tokens: 0, medianPeakX: null },
          { label: "5-15m", tokens: 0, medianPeakX: null },
          { label: "15-60m", tokens: 0, medianPeakX: null },
          { label: ">1h", tokens: 0, medianPeakX: null },
        ],
      });
      expect(JSON.stringify(body)).not.toContain(CRASHED);
    });

    it("answers null statistics for a range without cycles, echoing the range", async () => {
      const { get } = await start();

      const { body } = await get("/api/analysis/cycles?from=2020-01-01&to=2020-01-08T00:00:00.000Z");

      expect(body).toMatchObject({
        from: "2020-01-01T00:00:00.000Z",
        to: "2020-01-08T00:00:00.000Z",
        tokens: 0,
        appearedInTimePct: null,
        appearedLatePct: null,
        explodedPct: null,
        neverExplodedPct: null,
        crashedPct: null,
        medianInvestWindowSeconds: null,
        medianPeakX: null,
        medianSecondsToPeak: null,
        medianSecondsPeakToCrash: null,
      });
      expect(body.windowBuckets).toHaveLength(6);
      expect(body.windowBuckets.every((bucket: { tokens: number; medianPeakX: unknown }) => bucket.tokens === 0 && bucket.medianPeakX === null)).toBe(true);
    });

    it("only counts cycles that appeared inside the range", async () => {
      const { get } = await start();

      expect((await get(`/api/analysis/cycles?from=${iso(100)}&to=${iso(101)}`)).body.tokens).toBe(3);
      expect((await get(`/api/analysis/cycles?from=${iso(101)}`)).body.tokens).toBe(0);
      expect((await get(`/api/analysis/cycles?to=${iso(100)}`)).body.tokens).toBe(0);
    });

    it("answers 400 INVALID_QUERY for a bad date", async () => {
      const { get } = await start();

      const { status, body } = await get("/api/analysis/cycles?from=yesterday");

      expect(status).toBe(400);
      expect(body.error).toEqual({ code: "INVALID_QUERY", message: 'Invalid query parameter "from": expected an ISO 8601 date or date-time' });
    });
  });

  it("answers 401 UNAUTHENTICATED without a session, revealing nothing", async () => {
    const { base } = await start();

    for (const path of ["/api/analysis/cycles", `/api/tokens/${CRASHED}`, "/api/tokens?phase=crashed", "/api/tokens?phase=mooning"]) {
      const response = await globalThis.fetch(`${base}${path}`);
      expect(response.status).toBe(401);
      expect((await response.json()).error.code).toBe("UNAUTHENTICATED");
    }
  });
});
