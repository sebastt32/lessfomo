import type { AddressInfo } from "node:net";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterEach, describe, expect, it } from "vitest";
import { loadAppConfig } from "../config/app-config.js";
import { ConfigModule } from "../config/config.module.js";
import { HISTORY_STORE } from "../history/history.module.js";
import { SqliteHistoryRecorder } from "../history/infrastructure/sqlite/sqlite-history-recorder.js";
import { LiveFeed } from "../live-feed/application/live-feed.js";
import { LIVE_FEED } from "../live-feed/live-feed.module.js";
import { SOL_USD_PRICE } from "../market-price/market-price.module.js";
import type { NewToken } from "../token-discovery/domain/new-token.js";
import type { WalletRecord, WalletStyle } from "../wallet-reputation/domain/reputation-rules.js";
import type { SmartWalletEntry } from "../wallet-reputation/domain/wallet-reputation-store.js";
import { createTestSession } from "../auth/testing/signed-in.js";
import { ApiModule } from "./api.module.js";
import { API_ERROR_REPORTER } from "./http/api-exception.filter.js";
import { API_APPLICATION_OPTIONS, createApiHttpAdapter } from "./http/api-http-adapter.js";
import { TokenVisibility } from "./token-visibility.js";

/** Base58 addresses of 44 characters. */
const address = (prefix: string) => `${prefix}${"1".repeat(44 - prefix.length)}`;
/** 2 conviction wallets and 3 flippers (5 smart wallets): hidden. */
const TWO = address("Two");
/** 3 conviction wallets: public. */
const THREE = address("Three");
const LIVE = address("Live");
const WALLET = address("Hodr");

const token = (mint: string, detectedAt: Date): NewToken => ({
  mint,
  name: `Name ${mint.slice(0, 5)}`,
  symbol: mint.slice(0, 5).toUpperCase(),
  creator: address("Dev"),
  signature: "sig",
  metadataUri: "",
  bondingCurve: "curve",
  pool: "pump",
  initialBuyTokens: 0,
  initialBuySol: 0,
  marketCapSol: 30,
  detectedAt,
});

const entry = (wallet: string, firstBuyAt: Date, styleAtEntry: WalletStyle = "conviction"): SmartWalletEntry => ({
  wallet,
  tierAtEntry: "good",
  styleAtEntry,
  firstBuyAt,
  entrySeconds: 10,
  boughtSol: 1,
  soldSol: 0,
  stillHolding: true,
});

const record = (wallet: string): WalletRecord => ({
  address: wallet,
  tier: "good",
  isBot: false,
  tokens: 6,
  wins: 4,
  winRate: 66.67,
  netPnlSol: 2,
  avgPnlSol: 0.33,
  medianEntrySeconds: 10,
  style: "conviction",
  flipRate: 0,
  medianHoldSeconds: null,
  lastActiveAt: new Date(),
  updatedAt: new Date(),
});

const momentum = (mint: string, score: number) => ({
  mint,
  at: new Date(),
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

/** Every request of this file is made by a signed-in session (docs/API.md "Authentication"). */
const session = createTestSession();
const fetch = session.fetch;

let app: INestApplication | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

/** The API with the default config (no PUBLIC_MIN_CONVICTION_WALLETS): TWO and THREE as above; WALLET has a result in each. */
const start = async () => {
  const now = new Date();
  const config = loadAppConfig({}, now);
  const history = new SqliteHistoryRecorder(":memory:");
  const wallets: Record<string, WalletStyle[]> = {
    [TWO]: ["conviction", "conviction", "flipper", "flipper", "flipper"],
    [THREE]: ["conviction", "conviction", "conviction"],
  };
  for (const [mint, styles] of Object.entries(wallets)) {
    await history.recordToken(token(mint, now));
    await history.recordScreening({ token: token(mint, now), status: "unverified", reason: "test" }, now);
    for (const [i, style] of styles.entries()) await history.saveSmartWallet(mint, entry(address(`W${i}${mint.slice(0, 2)}`), now, style));
    const closedAt = new Date(now.getTime() - 60_000);
    await history.saveTokenClose({
      mint,
      detectedAt: now,
      closedAt,
      results: [{ wallet: WALLET, firstBuyAt: now, firstSellAt: null, entrySeconds: 1, boughtSol: 1, soldSol: 2, pnlSol: 1, closedAt }],
      smartWallets: styles.map((style, i) => entry(address(`W${i}${mint.slice(0, 2)}`), now, style)),
      outcome: null,
    });
  }
  const feed = new LiveFeed(config.api.publicMinConvictionWallets);
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
  return { feed, get, base, visibility: app.get(TokenVisibility) };
};

const mintsOf = (items: readonly { token?: { mint: string }; mint?: string }[]) =>
  items.map((item) => item.token?.mint ?? item.mint);

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

const summary = (count: number, conviction: number) => ({ count, elite: 0, holding: count, conviction });

describe("public visibility with the default PUBLIC_MIN_CONVICTION_WALLETS (3)", () => {
  it("answers 404 everywhere for a token with 2 conviction wallets (and 3 flippers) and serves the one with 3", async () => {
    const { get } = await start();

    for (const path of ["", "/candles", "/snapshots", "/smart-wallets"]) {
      const hidden = await get(`/api/tokens/${TWO}${path}`);
      expect([path, hidden.status, hidden.body.error.code]).toEqual([path, 404, "TOKEN_NOT_FOUND"]);
    }
    expect((await get(`/api/tokens/${THREE}`)).status).toBe(200);
    const wallets = (await get(`/api/tokens/${THREE}/smart-wallets`)).body.smartWallets;
    expect(wallets.map((w: { styleAtEntry: string }) => w.styleAtEntry)).toEqual(["conviction", "conviction", "conviction"]);
    const walletBody = (await get(`/api/wallets/${WALLET}`)).body;
    expect(mintsOf(walletBody.results)).toEqual([THREE]);
  });

  it("leaves the token with 2 conviction wallets out of lists, treats minConvictionWallets=2 as 3 and keeps minSmartWallets as an extra filter", async () => {
    const { get, visibility } = await start();

    const all = await get("/api/tokens");
    const two = await get("/api/tokens?minConvictionWallets=2");
    const four = await get("/api/tokens?minConvictionWallets=4");
    const fiveSmart = await get("/api/tokens?minSmartWallets=5");
    const sorted = await get("/api/tokens?sort=convictionWallets:desc");

    expect([all.body.total, mintsOf(all.body.tokens)]).toEqual([1, [THREE]]);
    expect(all.body.tokens[0].smartWallets).toEqual(summary(3, 3));
    expect([two.body.total, mintsOf(two.body.tokens)]).toEqual([1, [THREE]]);
    expect(four.body.total).toBe(0);
    expect(fiveSmart.body.total).toBe(0); // TWO has 5 smart wallets but only 2 conviction ones
    expect(mintsOf(sorted.body.tokens)).toEqual([THREE]);
    expect(mintsOf((await get("/api/screenings")).body.screenings)).toEqual([THREE]);
    expect(mintsOf((await get("/api/screenings?minConvictionWallets=2")).body.screenings)).toEqual([THREE]);
    expect((await get("/api/screenings?minSmartWallets=4")).body.screenings).toEqual([]);
    expect((await get("/api/screenings")).body.screenings[0].smartWallets).toEqual(summary(3, 3));
    for (const path of ["/api/tokens", "/api/movers", "/api/screenings"]) {
      expect((await get(`${path}?minConvictionWallets=2.5`)).body.error).toEqual({
        code: "INVALID_QUERY",
        message: 'Invalid query parameter "minConvictionWallets": expected an integer',
      });
    }
    expect([...(await visibility.publicMints([TWO, THREE]))]).toEqual([THREE]);
    expect([await visibility.isPublic(TWO), await visibility.isPublic(THREE)]).toEqual([false, true]);
  });

  it("shows a live token only when its 3rd conviction wallet buys; flippers never count", async () => {
    const { feed, get, base } = await start();
    const live = token(LIVE, new Date());
    feed.tokenDetected(live);
    feed.screeningFinished({ token: live, status: "unverified", reason: "test" }, new Date());
    const buy = (count: number, conviction: number, style: WalletStyle) =>
      feed.smartWalletChanged({
        mint: LIVE,
        smartWallets: summary(count, conviction),
        wallet: { ...entry(address(`Buyer${count}`), new Date(), style), record: record(address(`Buyer${count}`)) },
      });
    const response = await fetch(`${base}/api/stream`);
    const tokenStream = await fetch(`${base}/api/tokens/${LIVE}/stream`);

    setTimeout(() => {
      buy(1, 1, "conviction");
      buy(2, 1, "flipper");
      buy(3, 1, "flipper");
      buy(4, 1, "flipper");
      buy(5, 2, "conviction");
      feed.momentumUpdated([momentum(LIVE, 10)], new Date());
      feed.tradeRecorded({ signature: "t1", mint: LIVE, trader: WALLET, side: "buy", solAmount: 1, tokenAmount: 10, priceSol: 0.1, timestamp: new Date() });
      buy(6, 3, "conviction");
      feed.momentumUpdated([momentum(LIVE, 20)], new Date());
      feed.tradeRecorded({ signature: "t2", mint: LIVE, trader: WALLET, side: "buy", solAmount: 1, tokenAmount: 10, priceSol: 0.1, timestamp: new Date() });
    }, 20);
    const text = await readSse(response, (t) => (t.match(/event: momentum/g) ?? []).length >= 2);
    const perToken = await readSse(tokenStream, (t) => t.includes("event: trade"));

    const events = [...text.matchAll(/event: (\S+)\ndata: (.*)\n/g)].map(([, name, data]) => [name, JSON.parse(data ?? "null")]);
    expect(events.map(([name]) => name)).toEqual(["status", "momentum", "token", "screening", "smart-wallet", "momentum"]);
    expect(events[1]?.[1].movers).toEqual([]);
    expect(events[4]?.[1].smartWallets).toEqual(summary(6, 3));
    expect(mintsOf(events[5]?.[1].movers)).toEqual([LIVE]);
    expect([...perToken.matchAll(/event: trade\ndata: (.*)\n/g)].map(([, data]) => JSON.parse(data ?? "null").signature)).toEqual(["t2"]);
    expect(mintsOf((await get("/api/movers")).body.movers)).toEqual([LIVE]);
    expect(mintsOf((await get("/api/movers?minConvictionWallets=2")).body.movers)).toEqual([LIVE]);
    expect((await get("/api/movers?minConvictionWallets=4")).body.movers).toEqual([]);
    expect((await get("/api/movers?minSmartWallets=7")).body.movers).toEqual([]);
    expect((await get(`/api/tokens/${LIVE}/smart-wallets`)).status).toBe(404); // never stored: not a known token
  });

  it("keeps movers with 2 live conviction wallets (and many flippers) out of /api/movers and the stream", async () => {
    const { feed, get } = await start();
    feed.tokenDetected(token(LIVE, new Date()));
    feed.smartWalletChanged({
      mint: LIVE,
      smartWallets: summary(9, 2),
      wallet: { ...entry(address("Buyer9"), new Date(), "flipper"), record: record(address("Buyer9")) },
    });
    feed.momentumUpdated([momentum(LIVE, 10)], new Date());

    expect((await get("/api/movers")).body.movers).toEqual([]);
    expect((await get("/api/movers?minConvictionWallets=0")).body.movers).toEqual([]);
    expect(feed.isPublic(LIVE)).toBe(false);
  });
});
