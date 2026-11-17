import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API_APPLICATION_OPTIONS, createApiHttpAdapter } from "../api/http/api-http-adapter.js";
import { AppModule } from "../app.module.js";
import { createTestSession } from "../auth/testing/signed-in.js";
import { runLessfomo } from "../bootstrap.js";
import { loadAppConfig, type AppConfig } from "../config/app-config.js";
import { HISTORY_STORE } from "../history/history.module.js";
import { SqliteHistoryRecorder } from "../history/infrastructure/sqlite/sqlite-history-recorder.js";
import { SOL_PRICE_FEED } from "../market-price/market-price.module.js";
import type { Trade } from "../momentum/domain/trade.js";
import { TRADE_SOURCE } from "../momentum/momentum.module.js";
import { HOLDER_DISTRIBUTION_READER, MINT_AUTHORITY_READER } from "../safety-checks/safety-checks.module.js";
import { MARKET_DATA_SOURCE } from "../snapshots/snapshots.module.js";
import type { NewToken } from "../token-discovery/domain/new-token.js";
import { NEW_TOKEN_SOURCE } from "../token-discovery/token-discovery.module.js";
import type { SmartWalletTracker } from "../wallet-reputation/application/smart-wallet-tracker.js";
import { SMART_WALLET_TRACKER } from "../wallet-reputation/wallet-reputation.module.js";
import type { TokenCycleTracker } from "./application/token-cycle-tracker.js";
import { TOKEN_CYCLE_TRACKER } from "./token-cycle.module.js";

/** The whole app with a real SQLite history and fake sources: the wiring of cycles and extended trade storage. */

const session = createTestSession();
const fetch = session.fetch;

const address = (prefix: string) => `${prefix}${"1".repeat(44 - prefix.length)}`;
const PUBLIC = address("Pub");
const PLAIN = address("Other");
const HOUR = 3_600_000;
/** A momentum window short enough to see it end. */
const SHORT_WINDOW_MS = 400;

class FakeSource<T> {
  private listener: ((item: T) => void) | null = null;
  start(listener: (item: T) => void): void {
    this.listener = listener;
  }
  stop(): void {
    this.listener = null;
  }
  emit(item: T): void {
    this.listener?.(item);
  }
}

const token = (mint: string, detectedAt: Date): NewToken => ({
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
  detectedAt,
});

let sequence = 0;
const trade = (mint: string, trader: string, at: Date, priceSol: number, side: "buy" | "sell" = "buy"): Trade => ({
  signature: `sig-${(sequence += 1)}`,
  mint,
  trader,
  side,
  solAmount: 0.5,
  tokenAmount: 1000,
  priceSol,
  timestamp: at,
});

const freePort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
};

const until = async (condition: () => boolean | Promise<boolean>): Promise<void> => {
  for (let i = 0; i < 400 && !(await condition()); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(await condition()).toBe(true);
};

let app: INestApplication | null = null;
beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(async () => {
  await app?.close();
  app = null;
  vi.restoreAllMocks();
});

const boot = async (trackingWindowMs = HOUR) => {
  const port = await freePort();
  const base = loadAppConfig({ API_PORT: String(port), PUBLIC_MIN_CONVICTION_WALLETS: "1" }, new Date());
  const config: AppConfig = {
    ...base,
    api: { ...base.api, port },
    screening: { evaluationDelayMs: 5, minIntervalMs: 1, maxPending: 50 },
    momentum: { ...base.momentum, trackingWindowMs, reportIntervalMs: 30 },
  };
  const history = new SqliteHistoryRecorder(":memory:");
  // "conviction" won five tokens it held: a good wallet with the conviction style at any later buy.
  const now = Date.now();
  for (let i = 0; i < 5; i += 1) {
    const closedAt = new Date(now - (i + 2) * HOUR);
    await history.saveTokenClose({
      mint: address(`Won${i + 2}`),
      detectedAt: new Date(closedAt.getTime() - HOUR),
      closedAt,
      results: [
        { wallet: "conviction", firstBuyAt: new Date(closedAt.getTime() - 50 * 60_000), firstSellAt: null, entrySeconds: 600, boughtSol: 1, soldSol: 2, pnlSol: 1, closedAt },
      ],
      smartWallets: [],
      outcome: null,
    });
  }
  const tokens = new FakeSource<NewToken>();
  const trades = new FakeSource<Trade>();
  const moduleRef = await session
    .signIn(Test.createTestingModule({ imports: [AppModule.forRoot(config)] }))
    .overrideProvider(NEW_TOKEN_SOURCE)
    .useValue(tokens)
    .overrideProvider(TRADE_SOURCE)
    .useValue(trades)
    .overrideProvider(SOL_PRICE_FEED)
    .useValue({ current: () => null, subscribe: () => () => undefined, start: () => undefined, stop: () => undefined })
    .overrideProvider(MINT_AUTHORITY_READER)
    .useValue({ read: async () => null })
    .overrideProvider(HOLDER_DISTRIBUTION_READER)
    .useValue({ read: async () => null })
    .overrideProvider(HISTORY_STORE)
    .useValue({ history, description: "sqlite" })
    .overrideProvider(MARKET_DATA_SOURCE)
    .useValue({ quotes: async () => new Map() })
    .compile();
  app = moduleRef.createNestApplication(createApiHttpAdapter(), API_APPLICATION_OPTIONS);
  await runLessfomo(app, config);
  const smartWallets = app.get<SmartWalletTracker>(SMART_WALLET_TRACKER);
  const cycles = app.get<TokenCycleTracker>(TOKEN_CYCLE_TRACKER);
  const get = async (path: string) => (await fetch(`http://127.0.0.1:${port}${path}`)).json();
  const storedTrades = (mint: string): number => Number(history.query("SELECT COUNT(*) AS n FROM trades WHERE mint = ?", mint)[0]?.["n"]);
  /** The reputation closer rates live first buys once every earlier result is stored. */
  const rate = async (): Promise<void> => {
    await smartWallets.rateThrough(new Date(Date.now() + HOUR));
    await cycles.idle();
  };
  return { history, tokens, trades, cycles, get, storedTrades, rate, port };
};

describe("token cycle wiring", () => {
  it("gives a token its cycle when a conviction wallet makes it public, and keeps it updated trade by trade", async () => {
    const { history, tokens, trades, cycles, get, rate } = await boot();
    const detectedAt = new Date(Math.floor(Date.now() / 1000) * 1000 - 3000);
    const seconds = (n: number) => new Date(detectedAt.getTime() + n * 1000);
    tokens.emit(token(PUBLIC, detectedAt));
    trades.emit(trade(PUBLIC, "dev", seconds(0), 1));
    trades.emit(trade(PUBLIC, "conviction", seconds(1), 1.5));
    trades.emit(trade(PUBLIC, "someone", seconds(2), 1.6));
    await until(() => history.query("SELECT 1 FROM trades WHERE mint = ?", PUBLIC).length === 3);
    expect(await history.tokenCycle(PUBLIC)).toBeNull();
    expect((await get(`/api/tokens/${PUBLIC}`)).error?.code).toBe("TOKEN_NOT_FOUND");

    await rate();

    // It appeared at the conviction wallet's buy (1 s), not when it was rated: base 1.5, launch 1.
    expect((await get(`/api/tokens/${PUBLIC}`)).cycle).toMatchObject({
      appearedAt: seconds(1).toISOString(),
      launchPriceSol: 1,
      appearedPriceSol: 1.5,
      appearedLate: false,
      phase: "stable",
      lastPriceX: 1.0667,
    });

    trades.emit(trade(PUBLIC, "someone", seconds(2), 3.3));
    await until(async () => (await history.tokenCycle(PUBLIC))?.state.phase === "exploding");
    await cycles.idle();
    const exploding = (await get(`/api/tokens/${PUBLIC}`)).cycle;
    expect(exploding).toMatchObject({ phase: "exploding", explosionAt: seconds(2).toISOString(), runStartAt: seconds(2).toISOString(), investWindowSeconds: 1, peakX: 2.2 });
    expect((await get("/api/tokens")).tokens.map((item: { token: { mint: string }; cycle: { phase: string } }) => [item.token.mint, item.cycle.phase])).toEqual([
      [PUBLIC, "exploding"],
    ]);
    expect((await get("/api/analysis/cycles")).tokens).toBe(1);
  });

  it("keeps storing and streaming the trades of a public token after the momentum window, and stops for the others", async () => {
    const { history, tokens, trades, cycles, storedTrades, rate, port } = await boot(SHORT_WINDOW_MS);
    const detectedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
    tokens.emit(token(PUBLIC, detectedAt));
    tokens.emit(token(PLAIN, detectedAt));
    trades.emit(trade(PUBLIC, "conviction", detectedAt, 1));
    trades.emit(trade(PLAIN, "someone", detectedAt, 1));
    await rate();
    expect((await history.tokenCycle(PUBLIC))?.state.phase).toBe("stable");
    const logged: string[] = [];
    vi.mocked(console.log).mockImplementation((line: string) => void logged.push(line));

    // The momentum tracker drops both tokens once its window ended: neither is tracked live any more.
    await until(() => logged.some((line) => line.startsWith("[momentum] tracking 0 token(s)")));
    const stream = (await fetch(`http://127.0.0.1:${port}/api/tokens/${PUBLIC}/stream`)).body!.getReader();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const late = new Date(detectedAt.getTime() + 2 * HOUR);
    trades.emit(trade(PUBLIC, "dev", late, 2.5, "sell"));
    trades.emit(trade(PLAIN, "someone", late, 2.5));
    await until(() => storedTrades(PUBLIC) === 2);
    await cycles.idle();

    expect(storedTrades(PLAIN)).toBe(1);
    expect((await history.tokenCycle(PUBLIC))?.state).toMatchObject({ phase: "exploding", explosionAt: late });
    let text = "";
    for (let chunk = await stream.read(); !chunk.done && !text.includes("event: cycle"); chunk = await stream.read()) {
      text += new TextDecoder().decode(chunk.value);
      if (text.includes("event: cycle")) break;
    }
    await stream.cancel();
    expect(JSON.parse(/event: trade\ndata: (.*)\n/.exec(text)?.[1] ?? "null")).toMatchObject({ trader: "dev", side: "sell", priceSol: 2.5, isDev: true });
    expect(JSON.parse(/event: cycle\ndata: (.*)\n/.exec(text)?.[1] ?? "null")).toMatchObject({ mint: PUBLIC, cycle: { phase: "exploding" } });
    // The trade after the window never reaches the reputation close: results use trades before closedAt only.
    expect(history.query("SELECT COUNT(*) AS n FROM trades WHERE mint = ? AND timestamp >= ?", PUBLIC, detectedAt.getTime() + SHORT_WINDOW_MS)[0]?.["n"]).toBe(1);
  });
});
