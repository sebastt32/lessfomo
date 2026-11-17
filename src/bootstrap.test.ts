import { createServer, type Server } from "node:net";
import type { AddressInfo } from "node:net";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API_APPLICATION_OPTIONS, createApiHttpAdapter } from "./api/http/api-http-adapter.js";
import { LiveStreams } from "./api/live-streams.js";
import { AppModule } from "./app.module.js";
import { createLessfomoApp, runLessfomo } from "./bootstrap.js";
import { loadAppConfig, type AppConfig } from "./config/app-config.js";
import { HISTORY_STORE } from "./history/history.module.js";
import { HistoryStoreUnavailableError } from "./history/infrastructure/open-history-store.js";
import { SOL_PRICE_FEED } from "./market-price/market-price.module.js";
import type { Trade } from "./momentum/domain/trade.js";
import { TRADE_SOURCE } from "./momentum/momentum.module.js";
import { HOLDER_DISTRIBUTION_READER, MINT_AUTHORITY_READER } from "./safety-checks/safety-checks.module.js";
import { MARKET_DATA_SOURCE } from "./snapshots/snapshots.module.js";
import type { NewToken } from "./token-discovery/domain/new-token.js";
import { NEW_TOKEN_SOURCE } from "./token-discovery/token-discovery.module.js";
import type { SmartWalletTracker } from "./wallet-reputation/application/smart-wallet-tracker.js";
import { SMART_WALLET_TRACKER } from "./wallet-reputation/wallet-reputation.module.js";

const MINT = "E3rpattxgipu5MoxktjsXHwEaYVfmowta9tnCp6bpump";

const token: NewToken = {
  mint: MINT,
  name: "Monitoring",
  symbol: "MON",
  creator: "dev",
  signature: "sig",
  metadataUri: "https://example.com/meta.json",
  bondingCurve: "curve",
  pool: "pump",
  initialBuyTokens: 0,
  initialBuySol: 0.5,
  marketCapSol: 28,
  detectedAt: new Date(),
};

const trade: Trade = {
  signature: "tradeSig",
  mint: MINT,
  trader: "fan",
  side: "buy",
  solAmount: 0.25,
  tokenAmount: 9000,
  priceSol: 0.00003,
  timestamp: new Date(),
};

/** Every start, stop and close, in the order they happened. */
let events: string[] = [];

class FakeFeed<T> {
  private listener: ((item: T) => void) | null = null;
  constructor(private readonly name: string) {}
  start(listener: (item: T) => void): void {
    events.push(`${this.name}.start`);
    console.log(`[${this.name}] connecting`);
    this.listener = listener;
  }
  stop(): void {
    events.push(`${this.name}.stop`);
    this.listener = null;
  }
  emit(item: T): void {
    this.listener?.(item);
  }
}

class FakeSolPrice {
  current = (): number | null => null;
  subscribe = (): (() => void) => () => undefined;
  start = (): void => void events.push("solPrice.start");
  stop = (): void => void events.push("solPrice.stop");
}

class FakeHistory {
  tokens: string[] = [];
  trades: string[] = [];
  screenings: string[] = [];
  onClose: () => void = () => undefined;
  recordToken = async (t: NewToken): Promise<void> => void this.tokens.push(t.mint);
  recordTrade = async (t: Trade): Promise<void> => void this.trades.push(t.signature);
  recordScreening = async (result: { status: string }): Promise<void> => void this.screenings.push(result.status);
  recordMomentum = async (): Promise<void> => undefined;
  recentScreenings = async () => [];
  tokenHistory = async () => null;
  tokenChart = async () => null;
  watchedTokens = async () => [];
  dueTokens = async () => [];
  updateMarkets = async (): Promise<void> => undefined;
  smartWallets: string[] = [];
  saveSmartWallet = async (mint: string, entry: { wallet: string }): Promise<void> => void this.smartWallets.push(`${mint}:${entry.wallet}`);
  /** "fan" has good point-in-time stats at every buy and never flipped (conviction, D7). */
  statsAtBuys = async (buys: readonly { wallet: string }[]) =>
    new Map(buys.filter(({ wallet }) => wallet === "fan").map(({ wallet }) => [wallet, { tokens: 5, wins: 4, netPnlSol: 2, flips: 0 }] as const));
  close = async (): Promise<void> => {
    this.onClose();
    events.push("history.close");
  };
}

const testConfig = (port: number): AppConfig => {
  const config = loadAppConfig({ API_PORT: String(port), PUBLIC_MIN_CONVICTION_WALLETS: "1" }, new Date("2026-11-13T20:00:00.000Z"));
  return {
    ...config,
    api: { ...config.api, port },
    screening: { evaluationDelayMs: 5, minIntervalMs: 1, maxPending: 50 },
    momentum: { ...config.momentum, reportIntervalMs: 30 },
  };
};

let app: INestApplication | null = null;
let logs: string[] = [];
let errors: string[] = [];

beforeEach(() => {
  events = [];
  logs = [];
  errors = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => void logs.push(line));
  vi.spyOn(console, "error").mockImplementation((line: string) => void errors.push(line));
});

afterEach(async () => {
  await app?.close();
  app = null;
  vi.restoreAllMocks();
});

/** The whole app with every external source, reader and store replaced by fakes. */
const boot = async (config: AppConfig) => {
  const tokens = new FakeFeed<NewToken>("tokens");
  const trades = new FakeFeed<Trade>("trades");
  const history = new FakeHistory();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(config)] })
    .overrideProvider(NEW_TOKEN_SOURCE)
    .useValue(tokens)
    .overrideProvider(TRADE_SOURCE)
    .useValue(trades)
    .overrideProvider(SOL_PRICE_FEED)
    .useValue(new FakeSolPrice())
    .overrideProvider(MINT_AUTHORITY_READER)
    .useValue({ read: async () => null })
    .overrideProvider(HOLDER_DISTRIBUTION_READER)
    .useValue({ read: async () => null })
    .overrideProvider(HISTORY_STORE)
    .useValue({ history, description: "fake store" })
    .overrideProvider(MARKET_DATA_SOURCE)
    .useValue({ quotes: async () => new Map() })
    .compile();
  app = moduleRef.createNestApplication(createApiHttpAdapter(), API_APPLICATION_OPTIONS);
  await runLessfomo(app, config);
  return { app, tokens, trades, history };
};

const until = async (condition: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !condition(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(condition()).toBe(true);
};

const freePort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
};

describe("lessfomo app wiring", () => {
  it("logs the startup lines, then starts the token, SOL price and trade sources", async () => {
    const port = await freePort();

    await boot(testConfig(port));

    expect(logs).toEqual([
      "lessfomo: screening new pump.fun tokens and tracking momentum...",
      "[history] storing in fake store",
      `[api] listening on http://127.0.0.1:${port} (CORS: http://localhost:5173)`,
      "[tokens] connecting",
      "[trades] connecting",
    ]);
    expect(events).toEqual(["tokens.start", "solPrice.start", "trades.start"]);
  });

  it("feeds tokens and trades through history, screening, momentum and the API", async () => {
    const port = await freePort();
    const { app: running, tokens, trades, history } = await boot(testConfig(port));
    running.get<SmartWalletTracker>(SMART_WALLET_TRACKER).updateRecords([
      {
        address: "fan",
        tier: "good",
        isBot: false,
        tokens: 5,
        wins: 4,
        winRate: 80,
        netPnlSol: 2,
        avgPnlSol: 0.4,
        medianEntrySeconds: 10,
        lastActiveAt: null,
        updatedAt: new Date(),
      },
    ]);

    tokens.emit(token);
    trades.emit(trade);
    trades.emit({ ...trade, mint: "Untracked1111111111111111111111111", signature: "other" });
    // The reputation closer rates live buys once every result closed before them is stored.
    await running.get<SmartWalletTracker>(SMART_WALLET_TRACKER).rateThrough(new Date(Date.now() + 60 * 60_000));
    await until(() => logs.some((line) => line.startsWith("[momentum]")) && history.screenings.length > 0);

    expect(history.tokens).toEqual([MINT]);
    expect(history.trades).toEqual(["tradeSig"]);
    expect(history.screenings).toEqual(["unverified"]);
    expect(logs).toContain(`?  UNVERIFIED MON          ${MINT}  (Mint account not found)`);
    expect(logs).toContain("[momentum] tracking 1 token(s), 1 trade(s) buffered, 1 active");
    const movers = await (await fetch(`http://127.0.0.1:${port}/api/movers`)).json();
    // "fan" is a good wallet: its buy makes the token public, counted live and stored.
    expect(movers.movers[0]).toMatchObject({ mint: MINT, status: "unverified", smartWallets: { count: 1, elite: 0, holding: 1, conviction: 1 } });
    expect(history.smartWallets).toEqual([`${MINT}:fan`]);
  });

  it("shuts down the pipeline, then the API and its streams, then the history", async () => {
    const port = await freePort();
    const { app: running, history } = await boot(testConfig(port));
    const stream = (await fetch(`http://127.0.0.1:${port}/api/stream`)).body!.getReader();
    await stream.read();
    let apiStateAtHistoryClose = "";
    history.onClose = () => {
      const server = running.getHttpServer() as Server;
      apiStateAtHistoryClose = `listening=${server.listening} streams=${running.get(LiveStreams).count()}`;
    };

    await running.close();
    app = null;

    expect(events.slice(3)).toEqual(["solPrice.stop", "trades.stop", "tokens.stop", "history.close"]);
    expect(apiStateAtHistoryClose).toBe("listening=false streams=0");
    while (!(await stream.read()).done);
  });

  it("keeps screening when the API cannot start", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const { port } = blocker.address() as AddressInfo;

    try {
      const { tokens, history } = await boot(testConfig(port));
      tokens.emit(token);

      expect(errors).toEqual([`[api] could not start: listen EADDRINUSE: address already in use 127.0.0.1:${port}`]);
      expect(logs.some((line) => line.startsWith("[api] listening"))).toBe(false);
      expect(events).toEqual(["tokens.start", "solPrice.start", "trades.start"]);
      expect(history.tokens).toEqual([MINT]);
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });

  it("rejects with HistoryStoreUnavailableError when the store cannot be opened", async () => {
    const config = loadAppConfig({ DATABASE_URL: "postgres://lessfomo@127.0.0.1:1/lessfomo" }, new Date());

    const created = createLessfomoApp(config);

    await expect(created).rejects.toBeInstanceOf(HistoryStoreUnavailableError);
    await expect(created).rejects.toThrow(/ECONNREFUSED/);
  });
});
