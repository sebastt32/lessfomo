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
import type { WalletRecord } from "../wallet-reputation/domain/reputation-rules.js";
import type { SmartWalletEntry } from "../wallet-reputation/domain/wallet-reputation-store.js";
import { ApiModule } from "./api.module.js";
import { API_ERROR_REPORTER } from "./http/api-exception.filter.js";
import { API_APPLICATION_OPTIONS, createApiHttpAdapter } from "./http/api-http-adapter.js";
import { TokenVisibility } from "./token-visibility.js";

/** Base58 addresses of 44 characters. */
const address = (prefix: string) => `${prefix}${"1".repeat(44 - prefix.length)}`;
const FOUR = address("Four");
const FIVE = address("Five");
const LIVE = address("Live");

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

const entry = (wallet: string, firstBuyAt: Date): SmartWalletEntry => ({
  wallet,
  tierAtEntry: "good",
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

let app: INestApplication | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

/** The API with the default config (no PUBLIC_MIN_SMART_WALLETS): FOUR has 4 stored good wallets, FIVE has 5. */
const start = async () => {
  const now = new Date();
  const config = loadAppConfig({}, now);
  const history = new SqliteHistoryRecorder(":memory:");
  for (const [mint, wallets] of [
    [FOUR, 4],
    [FIVE, 5],
  ] as const) {
    await history.recordToken(token(mint, now));
    await history.recordScreening({ token: token(mint, now), status: "unverified", reason: "test" }, now);
    for (let i = 0; i < wallets; i += 1) await history.saveSmartWallet(mint, entry(address(`W${i}${mint.slice(0, 2)}`), now));
  }
  const feed = new LiveFeed(config.api.publicMinSmartWallets);
  const moduleRef = await Test.createTestingModule({ imports: [ConfigModule.forRoot(config), ApiModule] })
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

describe("public visibility with the default PUBLIC_MIN_SMART_WALLETS (5)", () => {
  it("answers 404 for a token with 4 smart wallets everywhere and serves the one with 5", async () => {
    const { get } = await start();

    for (const path of ["", "/candles", "/snapshots", "/smart-wallets"]) {
      const hidden = await get(`/api/tokens/${FOUR}${path}`);
      expect([path, hidden.status, hidden.body.error.code]).toEqual([path, 404, "TOKEN_NOT_FOUND"]);
    }
    expect((await get(`/api/tokens/${FIVE}`)).status).toBe(200);
    expect((await get(`/api/tokens/${FIVE}/smart-wallets`)).body.smartWallets).toHaveLength(5);
  });

  it("leaves a token with 4 smart wallets out of lists and treats minSmartWallets=2 as 5", async () => {
    const { get, visibility } = await start();

    const all = await get("/api/tokens");
    const two = await get("/api/tokens?minSmartWallets=2");
    const six = await get("/api/tokens?minSmartWallets=6");

    expect([all.body.total, mintsOf(all.body.tokens)]).toEqual([1, [FIVE]]);
    expect([two.body.total, mintsOf(two.body.tokens)]).toEqual([1, [FIVE]]);
    expect(six.body.total).toBe(0);
    expect(mintsOf((await get("/api/screenings")).body.screenings)).toEqual([FIVE]);
    expect(mintsOf((await get("/api/screenings?minSmartWallets=2")).body.screenings)).toEqual([FIVE]);
    expect((await get("/api/tokens?minSmartWallets=2.5")).body.error).toEqual({
      code: "INVALID_QUERY",
      message: 'Invalid query parameter "minSmartWallets": expected an integer',
    });
    expect([...(await visibility.publicMints([FOUR, FIVE]))]).toEqual([FIVE]);
  });

  it("shows a live token only when its 5th good wallet buys", async () => {
    const { feed, get, base } = await start();
    const live = token(LIVE, new Date());
    feed.tokenDetected(live);
    feed.screeningFinished({ token: live, status: "unverified", reason: "test" }, new Date());
    const buy = (count: number) =>
      feed.smartWalletChanged({
        mint: LIVE,
        smartWallets: { count, elite: 0, holding: count },
        wallet: { ...entry(address(`Buyer${count}`), new Date()), record: record(address(`Buyer${count}`)) },
      });
    const response = await fetch(`${base}/api/stream`);

    setTimeout(() => {
      for (let count = 1; count <= 4; count += 1) buy(count);
      feed.momentumUpdated([momentum(LIVE, 10)], new Date());
      buy(5);
      feed.momentumUpdated([momentum(LIVE, 20)], new Date());
    }, 20);
    const text = await readSse(response, (t) => (t.match(/event: momentum/g) ?? []).length >= 2);

    const events = [...text.matchAll(/event: (\S+)\ndata: (.*)\n/g)].map(([, name, data]) => [name, JSON.parse(data ?? "null")]);
    expect(events.map(([name]) => name)).toEqual(["status", "momentum", "token", "screening", "smart-wallet", "momentum"]);
    expect(events[1]?.[1].movers).toEqual([]);
    expect(events[4]?.[1].smartWallets).toEqual({ count: 5, elite: 0, holding: 5 });
    expect(mintsOf(events[5]?.[1].movers)).toEqual([LIVE]);
    expect(mintsOf((await get("/api/movers")).body.movers)).toEqual([LIVE]);
    expect(mintsOf((await get("/api/movers?minSmartWallets=2")).body.movers)).toEqual([LIVE]);
  });

  it("keeps movers with 4 live smart wallets out of /api/movers", async () => {
    const { feed, get } = await start();
    feed.tokenDetected(token(LIVE, new Date()));
    feed.smartWalletChanged({
      mint: LIVE,
      smartWallets: { count: 4, elite: 0, holding: 4 },
      wallet: { ...entry(address("Buyer4"), new Date()), record: record(address("Buyer4")) },
    });
    feed.momentumUpdated([momentum(LIVE, 10)], new Date());

    expect((await get("/api/movers")).body.movers).toEqual([]);
    expect((await get("/api/movers?minSmartWallets=2")).body.movers).toEqual([]);
  });
});
