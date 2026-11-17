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
import type { Trade } from "../momentum/domain/trade.js";
import type { NewToken } from "../token-discovery/domain/new-token.js";
import { ReputationCloser } from "../wallet-reputation/application/reputation-closer.js";
import { DEFAULT_REPUTATION_RULES, type WalletRecord } from "../wallet-reputation/domain/reputation-rules.js";
import { ApiModule } from "./api.module.js";
import { API_ERROR_REPORTER } from "./http/api-exception.filter.js";
import { API_APPLICATION_OPTIONS, createApiHttpAdapter } from "./http/api-http-adapter.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Base58 addresses of 44 characters. */
const address = (prefix: string) => `${prefix}${"1".repeat(44 - prefix.length)}`;
const DEV = address("Dev");
const SMART = address("Smart");
const NOBODY = address("Nobody");
const X = address("Xpump");
const EARLY = address("Before");
const UNKNOWN = address("Unknown");

const token = (mint: string, detectedAt: number): NewToken => ({
  mint,
  name: `Name ${mint.slice(0, 5)}`,
  symbol: mint.slice(0, 5).toUpperCase(),
  creator: DEV,
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

let app: INestApplication | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

/**
 * SMART wins five tokens closed by T0 + 1h40m. It buys EARLY before those closed (not smart at
 * that buy) and X after (good at that buy). Then the closer runs once, as in production.
 */
const start = async () => {
  const now = Date.now();
  const t0 = now - 10 * HOUR;
  const history = new SqliteHistoryRecorder(":memory:");
  const winning = async (mint: string, detectedAt: number, buyAt: number) => {
    await history.recordToken(token(mint, detectedAt));
    await history.recordTrade(trade(mint, DEV, "buy", detectedAt, 1, 1000));
    await history.recordTrade(trade(mint, SMART, "buy", buyAt, 1, 1000));
    await history.recordTrade(trade(mint, SMART, "sell", buyAt + MINUTE, 2, 1000));
  };
  for (let i = 0; i < 5; i += 1) await winning(address(`Win${i + 2}`), t0 + i * 10 * MINUTE, t0 + i * 10 * MINUTE + MINUTE);
  await winning(EARLY, t0 + 30 * MINUTE, t0 + 35 * MINUTE);
  const xAt = t0 + 2 * HOUR;
  await history.recordToken(token(X, xAt));
  await history.recordTrade(trade(X, DEV, "buy", xAt, 1, 1000));
  await history.recordTrade(trade(X, SMART, "buy", xAt + MINUTE, 1, 1000)); // entry 0.001
  await history.recordTrade(trade(X, NOBODY, "buy", xAt + 2 * MINUTE, 2.5, 1000)); // 0.0025 >= 2x
  for (const mint of [X, EARLY]) {
    await history.recordScreening({ token: token(mint, xAt), status: "unverified", reason: "test" }, new Date(xAt + MINUTE));
  }
  await new ReputationCloser({ store: history, rules: DEFAULT_REPUTATION_RULES, trackingWindowMs: HOUR, batchSize: 100 }).tick();

  const feed = new LiveFeed();
  const config = loadAppConfig({}, new Date(now));
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
  return { feed, get, base, xAt, t0 };
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

describe("smart wallets API", () => {
  it("lists only tokens bought by a smart wallet at its buy time, whatever minSmartWallets says", async () => {
    const { get } = await start();

    const all = await get("/api/tokens");
    const zero = await get("/api/tokens?minSmartWallets=0");
    const smart = await get("/api/tokens?minSmartWallets=1");
    const sorted = await get("/api/tokens?sort=smartWallets:desc");

    // Seven tokens are stored; EARLY was bought by SMART before it was good, so only X is public.
    expect([all.body.total, zero.body.total]).toEqual([1, 1]);
    expect((await get("/api/tokens?minSmartWallets=2")).body.total).toBe(0);
    expect(smart.body.total).toBe(1);
    expect(smart.body.tokens.map((t: { token: { mint: string }; smartWallets: unknown }) => [t.token.mint, t.smartWallets])).toEqual([
      [X, { count: 1, elite: 0, holding: 1 }],
    ]);
    expect(sorted.body.tokens[0].token.mint).toBe(X);
    expect((await get("/api/tokens?minSmartWallets=-1")).body.total).toBe(1);
    expect((await get("/api/tokens?minSmartWallets=1.5")).body.error.code).toBe("INVALID_QUERY");
  });

  it("filters screenings by the same point-in-time count and includes it in each one", async () => {
    const { get } = await start();

    const all = await get("/api/screenings");
    const smart = await get("/api/screenings?minSmartWallets=1");

    expect(all.body.screenings.map((s: { mint: string; smartWallets: unknown }) => [s.mint, s.smartWallets])).toEqual([
      [X, { count: 1, elite: 0, holding: 1 }],
    ]);
    expect(smart.body.screenings.map((s: { mint: string }) => s.mint)).toEqual([X]);
    expect((await get(`/api/tokens/${X}`)).body.screenings[0].smartWallets).toEqual({ count: 1, elite: 0, holding: 1 });
    expect((await get("/api/screenings?minSmartWallets=x")).status).toBe(400);
  });

  it("explains why each smart wallet of a token is good", async () => {
    const { get, xAt } = await start();

    const { status, body } = await get(`/api/tokens/${X}/smart-wallets`);

    expect(status).toBe(200);
    expect(body).toEqual({
      mint: X,
      smartWallets: [
        {
          address: SMART,
          tierAtEntry: "good",
          record: expect.objectContaining({ address: SMART, tier: "good", isBot: false, tokens: 7, wins: 7, winRate: 100, netPnlSol: 7.5 }),
          firstBuyAt: new Date(xAt + MINUTE).toISOString(),
          entrySeconds: 60,
          boughtSol: 1,
          soldSol: 0,
          stillHolding: true,
        },
      ],
    });
    for (const path of ["", "/candles", "/snapshots", "/smart-wallets"]) {
      expect(await get(`/api/tokens/${EARLY}${path}`)).toEqual({
        status: 404,
        body: { error: { code: "TOKEN_NOT_FOUND", message: "Token was never seen" } },
      });
    }
    expect((await get(`/api/tokens/${UNKNOWN}/smart-wallets`)).body.error.code).toBe("TOKEN_NOT_FOUND");
    expect((await get("/api/tokens/not-a-mint/smart-wallets")).body.error.code).toBe("INVALID_MINT");
  });

  it("returns a wallet's record and its results newest first", async () => {
    const { get, xAt } = await start();

    const { status, body } = await get(`/api/wallets/${SMART}`);

    expect(status).toBe(200);
    expect(body.record).toMatchObject({ address: SMART, tier: "good", tokens: 7, wins: 7, netPnlSol: 7.5, medianEntrySeconds: 60 });
    // The record rates all seven closed results; only the public token X is listed.
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toEqual({
      mint: X,
      symbol: "XPUMP",
      name: "Name Xpump",
      firstBuyAt: new Date(xAt + MINUTE).toISOString(),
      entrySeconds: 60,
      boughtSol: 1,
      soldSol: 0,
      pnlSol: 1.5,
      closedAt: new Date(xAt + HOUR).toISOString(),
    });
    expect(await get(`/api/wallets/${UNKNOWN}`)).toEqual({
      status: 404,
      body: { error: { code: "WALLET_NOT_FOUND", message: "Wallet has no closed results" } },
    });
    expect(await get("/api/wallets/bad!")).toEqual({
      status: 400,
      body: { error: { code: "INVALID_ADDRESS", message: "Address is not a base58 address" } },
    });
    expect((await get(`/api/wallets/${SMART}/other`)).body.error.code).toBe("INVALID_ADDRESS");
  });

  it("analyzes success per number of smart wallets", async () => {
    const { get, t0 } = await start();

    const { status, body } = await get(`/api/analysis/smart-wallets?from=${new Date(t0).toISOString()}`);

    expect(status).toBe(200);
    expect(body.from).toBe(new Date(t0).toISOString());
    expect(body.costRoundTrip).toBe(0.03);
    expect(body.buckets.map((b: { smartWallets: string; tokens: number }) => [b.smartWallets, b.tokens])).toEqual([
      ["0", 1],
      ["1", 1],
      ["2", 0],
      ["3", 0],
      ["4", 0],
      ["5+", 0],
    ]);
    // X: entry at SMART's buy (0.001), 0.0025 hits 2x → 2 − 1 − 3% = 97%.
    expect(body.buckets[1]).toEqual({
      smartWallets: "1",
      tokens: 1,
      reached2xPct: 100,
      migratedPct: 0,
      avgReturnPct: 97,
      medianReturnPct: 97,
      winnersPct: 100,
      medianPeakX: 2.5,
    });
    expect((await get("/api/analysis/smart-wallets?from=yesterday")).body.error.code).toBe("INVALID_QUERY");
  });

  it("filters movers by their live smart wallets and streams smart-wallet events", async () => {
    const { feed, get, base } = await start();
    const live = token(address("Live"), Date.now());
    const other = token(address("Other"), Date.now());
    feed.tokenDetected(live);
    feed.tokenDetected(other);
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
    feed.momentumUpdated([momentum(live.mint, 10), momentum(other.mint, 50)], new Date());
    const record: WalletRecord = {
      address: SMART,
      tier: "elite",
      isBot: false,
      tokens: 10,
      wins: 8,
      winRate: 80,
      netPnlSol: 7,
      avgPnlSol: 0.7,
      medianEntrySeconds: 30,
      lastActiveAt: new Date("2026-11-16T10:00:00.000Z"),
      updatedAt: new Date("2026-11-16T11:00:00.000Z"),
    };
    const response = await fetch(`${base}/api/stream`);
    setTimeout(() => {
      feed.smartWalletChanged({
        mint: live.mint,
        smartWallets: { count: 1, elite: 1, holding: 1 },
        wallet: {
          wallet: SMART,
          tierAtEntry: "elite",
          firstBuyAt: new Date("2026-11-16T12:00:05.000Z"),
          entrySeconds: 5,
          boughtSol: 0.5,
          soldSol: 0,
          stillHolding: true,
          record,
        },
      });
      feed.screeningFinished({ token: live, status: "unverified", reason: "test" }, new Date());
    }, 20);

    const text = await readSse(response, (t) => t.includes("event: screening"));

    expect(JSON.parse(/event: smart-wallet\ndata: (.*)\n/.exec(text)?.[1] ?? "null")).toEqual({
      mint: live.mint,
      smartWallets: { count: 1, elite: 1, holding: 1 },
      wallet: {
        address: SMART,
        tierAtEntry: "elite",
        record: {
          address: SMART,
          tier: "elite",
          isBot: false,
          tokens: 10,
          wins: 8,
          winRate: 80,
          netPnlSol: 7,
          avgPnlSol: 0.7,
          medianEntrySeconds: 30,
          lastActiveAt: "2026-11-16T10:00:00.000Z",
          updatedAt: "2026-11-16T11:00:00.000Z",
        },
        firstBuyAt: "2026-11-16T12:00:05.000Z",
        entrySeconds: 5,
        boughtSol: 0.5,
        soldSol: 0,
        stillHolding: true,
      },
    });
    expect(JSON.parse(/event: screening\ndata: (.*)\n/.exec(text)?.[1] ?? "null").smartWallets).toEqual({
      count: 1,
      elite: 1,
      holding: 1,
    });
    const movers = (await get("/api/movers")).body.movers;
    const smartMovers = (await get("/api/movers?minSmartWallets=1")).body.movers;
    expect(movers.map((m: { mint: string; smartWallets: unknown }) => [m.mint, m.smartWallets])).toEqual([
      [live.mint, { count: 1, elite: 1, holding: 1 }],
    ]);
    expect(smartMovers.map((m: { mint: string }) => m.mint)).toEqual([live.mint]);
    expect((await get("/api/movers?minSmartWallets=1.5")).body.error.code).toBe("INVALID_QUERY");
  });
});
