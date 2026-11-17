import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterEach, describe, expect, it } from "vitest";
import { loadAppConfig, type AppConfig } from "../config/app-config.js";
import { ConfigModule } from "../config/config.module.js";
import type { HistoryReader, StoredScreening, TokenChart, TokenHistory } from "../history/domain/history-reader.js";
import type {
  HistoryStats,
  TokenCatalogReader,
  TokenList,
  TokenListQuery,
  TokenSnapshots,
} from "../history/domain/token-catalog-reader.js";
import { HISTORY_STORE } from "../history/history.module.js";
import { LiveFeed } from "../live-feed/application/live-feed.js";
import { LIVE_FEED } from "../live-feed/live-feed.module.js";
import type { SolUsdListener, SolUsdPrice } from "../market-price/domain/sol-usd-price.js";
import { SOL_USD_PRICE } from "../market-price/market-price.module.js";
import type { MomentumSnapshot } from "../momentum/application/momentum-tracker.js";
import type { Trade } from "../momentum/domain/trade.js";
import type { NewToken } from "../token-discovery/domain/new-token.js";
import { ApiModule } from "./api.module.js";
import { API_ERROR_REPORTER } from "./http/api-exception.filter.js";
import { API_APPLICATION_OPTIONS, createApiHttpAdapter } from "./http/api-http-adapter.js";
import { LiveStreams } from "./live-streams.js";

const MINT = "E3rpattxgipu5MoxktjsXHwEaYVfmowta9tnCp6bpump";
const STARTED_AT = new Date("2026-11-13T20:00:00.000Z");

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
  detectedAt: new Date("2026-11-13T20:01:00.000Z"),
};

const metrics = {
  uniqueBuyers1m: 5,
  uniqueBuyers5m: 12,
  avgUniqueBuyersPrevMinutes: 1.75,
  buyVolumeSol5m: 2,
  sellVolumeSol5m: 0.5,
  tradeCount5m: 20,
  medianBuySol5m: 0.1,
  priceChange5mPct: 12.5,
  lastPriceSol: 0.00003,
};
const components = { activity: 0.24, acceleration: 1, buyPressure: 0.6 };

const snapshot: MomentumSnapshot = {
  mint: MINT,
  at: new Date("2026-11-13T20:05:00.000Z"),
  momentum: { score: 21, components, metrics },
};

const screening: StoredScreening = {
  mint: MINT,
  symbol: "MON",
  name: "Monitoring",
  status: "failed",
  reason: null,
  failureCodes: ["NOT_ENOUGH_HOLDERS"],
  top10Pct: 4.5,
  creatorPct: 0,
  totalHolders: 3,
  evaluatedAt: new Date("2026-11-13T20:02:00.000Z"),
  detectedAt: new Date("2026-11-13T20:01:00.000Z"),
  smartWallets: { count: 2, elite: 1, holding: 1, conviction: 1 },
};
const SCREENING_VIEW = { ...screening, evaluatedAt: "2026-11-13T20:02:00.000Z", detectedAt: "2026-11-13T20:01:00.000Z" };
const UNKNOWN_LIQUIDITY = { sol: null, bondingCurvePct: null, migrated: false };
const SMART = { count: 1, elite: 0, holding: 1, conviction: 1 };

/** A conviction wallet buys the token live: from then on it is public (docs/API.md "Public visibility rule"). */
const qualify = (feed: LiveFeed, mint = MINT): void =>
  feed.smartWalletChanged({
    mint,
    smartWallets: SMART,
    wallet: {
      wallet: "goodWallet",
      tierAtEntry: "good",
      styleAtEntry: "conviction",
      firstBuyAt: new Date("2026-11-13T20:01:30.000Z"),
      entrySeconds: 30,
      boughtSol: 1,
      soldSol: 0,
      stillHolding: true,
      record: {
        address: "goodWallet",
        tier: "good",
        isBot: false,
        tokens: 5,
        wins: 4,
        winRate: 80,
        netPnlSol: 2,
        avgPnlSol: 0.4,
        medianEntrySeconds: 12,
        lastActiveAt: null,
        updatedAt: new Date("2026-11-13T20:00:00.000Z"),
      },
    },
  });

const tokenSnapshots: TokenSnapshots = {
  lifecycle: "active",
  snapshots: [
    {
      mint: MINT,
      milestone: "0m",
      at: new Date("2026-11-13T20:01:03.000Z"),
      priceSol: 0.00000003,
      marketCapSol: 30,
      volumeSol: 0.5,
      buys: 1,
      sells: 0,
      uniqueBuyers: 1,
      holders: null,
      top10Pct: null,
      devHoldsPct: null,
      liquidity: { sol: 1.5, bondingCurvePct: 4.25, migrated: false },
      source: "trades",
    },
  ],
};

const stats: HistoryStats = {
  since: new Date("2026-11-13T20:01:00.000Z"),
  tokens: { total: 3, active: 2, dead: 1, migrated: 1 },
  screenings: { passed: 1, failed: 1, unverified: 0, pending: 1 },
  trades: 40,
  snapshots: 7,
};

const chart: TokenChart = {
  candles: [
    {
      start: new Date("2026-11-13T20:01:00.000Z"),
      open: 0.00003,
      high: 0.00005,
      low: 0.00002,
      close: 0.00004,
      volumeSol: 3,
      buyVolumeSol: 2,
      sellVolumeSol: 1,
      trades: 7,
    },
  ],
  devTrades: [{ at: new Date("2026-11-13T20:01:02.900Z"), side: "sell", solAmount: 1.5 }],
};

class FakeSolPrice implements SolUsdPrice {
  price: number | null = null;
  readonly listeners = new Set<SolUsdListener>();
  current(): number | null {
    return this.price;
  }
  subscribe(listener: SolUsdListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  set(price: number): void {
    this.price = price;
    for (const listener of this.listeners) listener(price);
  }
}

const tradeViewOf = (t: Trade) => ({
  signature: t.signature,
  trader: t.trader,
  side: t.side,
  solAmount: t.solAmount,
  tokenAmount: t.tokenAmount,
  priceSol: t.priceSol,
  isDev: false,
  time: Math.floor(t.timestamp.getTime() / 1000),
});

const trade = (overrides: Partial<Trade> = {}): Trade => ({
  signature: "tradeSig",
  mint: MINT,
  trader: "fan",
  side: "buy",
  solAmount: 0.25,
  tokenAmount: 9000,
  priceSol: 0.00003,
  timestamp: new Date("2026-11-13T20:01:05.750Z"),
  ...overrides,
});

class FakeHistory implements HistoryReader, TokenCatalogReader {
  /** Tokens with a stored good-or-elite wallet. */
  publicMints = new Set([MINT]);
  async tokenSmartSummary(mint: string) {
    if (this.fail) throw new Error("disk on fire");
    return this.publicMints.has(mint) ? { count: 2, elite: 1, holding: 1, conviction: 1 } : { count: 0, elite: 0, holding: 0, conviction: 0 };
  }
  async mintsWithSmartWallets(mints: readonly string[]) {
    return new Set(mints.filter((mint) => this.publicMints.has(mint)));
  }
  async mintsWithConvictionWallets(mints: readonly string[]) {
    return new Set(mints.filter((mint) => this.publicMints.has(mint)));
  }
  closed = false;
  listQueries: TokenListQuery[] = [];
  requestedLimits: number[] = [];
  chartRequests: { mint: string; intervalSeconds: number; limit: number }[] = [];
  fail = false;
  screeningMinimums: (number | undefined)[] = [];
  screeningConvictionMinimums: (number | undefined)[] = [];
  async recentScreenings(limit: number, minSmartWallets?: number, minConvictionWallets?: number): Promise<StoredScreening[]> {
    if (this.fail) throw new Error("disk on fire");
    this.requestedLimits.push(limit);
    this.screeningMinimums.push(minSmartWallets);
    this.screeningConvictionMinimums.push(minConvictionWallets);
    return [screening];
  }
  async tokenHistory(mint: string): Promise<TokenHistory | null> {
    if (this.fail) throw new Error("disk on fire");
    if (mint !== MINT) return null;
    return {
      token: {
        mint,
        symbol: "MON",
        name: "Monitoring",
        creator: "dev",
        metadataUri: "https://example.com/meta.json",
        initialBuySol: 0.5,
        marketCapSol: 28,
        detectedAt: token.detectedAt,
      },
      status: "failed",
      screenings: [screening],
      momentum: [{ at: snapshot.at, score: 21, components, metrics }],
    };
  }
  async tokenChart(mint: string, intervalSeconds: number, limit: number): Promise<TokenChart | null> {
    if (this.fail) throw new Error("disk on fire");
    this.chartRequests.push({ mint, intervalSeconds, limit });
    return mint === MINT ? chart : null;
  }
  async listTokens(query: TokenListQuery): Promise<TokenList> {
    if (this.fail) throw new Error("disk on fire");
    this.listQueries.push(query);
    return {
      total: 51,
      tokens: [
        {
          token: { ...token, detectedAt: token.detectedAt },
          status: "passed",
          lifecycle: "active",
          liquidity: { sol: 12.5, bondingCurvePct: 40.25, migrated: false },
          lastPriceSol: 0.00000004,
          peakPriceSol: 0.00000009,
          maxScore: 63,
          holders: 61,
          lastTradeAt: new Date("2026-11-13T20:30:00.000Z"),
          snapshotCount: 5,
          smartWallets: { count: 3, elite: 1, holding: 2, conviction: 2 },
        },
      ],
    };
  }
  async tokenSnapshots(mint: string): Promise<TokenSnapshots | null> {
    if (this.fail) throw new Error("disk on fire");
    return mint === MINT ? tokenSnapshots : null;
  }
  async stats(): Promise<HistoryStats> {
    if (this.fail) throw new Error("disk on fire");
    return stats;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

let app: INestApplication | null = null;

const configWith = (overrides: { heartbeatMs?: number }): AppConfig => {
  // These tests keep the old "one smart wallet" setting as one conviction wallet (D7 replaced the rule).
  const config = loadAppConfig({ PUBLIC_MIN_CONVICTION_WALLETS: "1" }, STARTED_AT);
  return { ...config, api: { ...config.api, ...overrides } };
};

/** The Nest API on a free port, with a real LiveFeed and fake history and SOL/USD price. */
const start = async (options: { heartbeatMs?: number } = {}) => {
  const feed = new LiveFeed(1);
  const history = new FakeHistory();
  const solPrice = new FakeSolPrice();
  const reported: unknown[] = [];
  const moduleRef = await Test.createTestingModule({ imports: [ConfigModule.forRoot(configWith(options)), ApiModule] })
    .overrideProvider(LIVE_FEED)
    .useValue(feed)
    .overrideProvider(HISTORY_STORE)
    .useValue({ history, description: "fake" })
    .overrideProvider(SOL_USD_PRICE)
    .useValue(solPrice)
    .overrideProvider(API_ERROR_REPORTER)
    .useValue((error: unknown) => reported.push(error))
    .compile();
  app = moduleRef.createNestApplication(createApiHttpAdapter(), API_APPLICATION_OPTIONS);
  await app.listen(0, "127.0.0.1");
  const { port } = app.getHttpServer().address() as AddressInfo;
  return { feed, history, solPrice, reported, base: `http://127.0.0.1:${port}` };
};

const streamCount = (): number | undefined => app?.get(LiveStreams).count();

afterEach(async () => {
  await app?.close();
  app = null;
});

/** Sends raw bytes and returns the whole HTTP response, for targets `fetch` would normalize or reject. */
const rawRequest = (base: string, head: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const { port } = new URL(base);
    const socket = connect(Number(port), "127.0.0.1", () => socket.write(`${head}\r\nHost: localhost\r\nConnection: close\r\n\r\n`));
    let raw = "";
    socket.on("data", (chunk) => (raw += chunk.toString()));
    socket.on("end", () => resolve(raw));
    socket.on("error", reject);
  });

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

describe("API (Nest e2e)", () => {
  it("reports health with source statuses", async () => {
    const { feed, base } = await start();
    feed.sourceStatusChanged("pumpportal", "connected");

    const response = await fetch(`${base}/api/health`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({
      status: "ok",
      startedAt: STARTED_AT.toISOString(),
      sources: { pumpportal: "connected", solanaLogs: "connecting" },
    });
  });

  it("returns no movers before the first momentum update", async () => {
    const { base } = await start();

    expect(await (await fetch(`${base}/api/movers`)).json()).toEqual({ at: null, movers: [] });
  });

  it("returns movers as views with ISO dates", async () => {
    const { feed, base } = await start();
    feed.tokenDetected(token);
    qualify(feed);
    feed.momentumUpdated([snapshot], snapshot.at);

    expect(await (await fetch(`${base}/api/movers`)).json()).toEqual({
      at: "2026-11-13T20:05:00.000Z",
      movers: [
        {
          mint: MINT,
          symbol: "MON",
          name: "Monitoring",
          status: "pending",
          detectedAt: "2026-11-13T20:01:00.000Z",
          score: 21,
          components,
          metrics,
          liquidity: UNKNOWN_LIQUIDITY,
          smartWallets: SMART,
        },
      ],
    });
  });

  it("reports each mover's latest bonding curve liquidity from its trades", async () => {
    const { feed, base } = await start();
    feed.tokenDetected(token);
    qualify(feed);
    feed.tradeRecorded(trade({ curve: { realSolReserves: 16.77, progressPct: 48.51, complete: false } }));
    feed.momentumUpdated([snapshot], snapshot.at);

    const body = await (await fetch(`${base}/api/movers`)).json();

    expect(body.movers[0].liquidity).toEqual({ sol: 16.77, bondingCurvePct: 48.51, migrated: false });
  });

  it("clamps limits and falls back to the default for invalid ones", async () => {
    const { history, base } = await start();

    await fetch(`${base}/api/screenings?limit=500`);
    await fetch(`${base}/api/screenings?limit=0`);
    await fetch(`${base}/api/screenings?limit=abc`);
    await fetch(`${base}/api/screenings`);

    expect(history.requestedLimits).toEqual([100, 1, 50, 50]);
  });

  it("returns recent screenings as views", async () => {
    const { base } = await start();

    expect(await (await fetch(`${base}/api/screenings`)).json()).toEqual({
      screenings: [SCREENING_VIEW],
    });
  });

  it("returns the history of one token", async () => {
    const { base } = await start();

    const body = await (await fetch(`${base}/api/tokens/${MINT}`)).json();

    expect(body).toEqual({
      token: {
        mint: MINT,
        symbol: "MON",
        name: "Monitoring",
        creator: "dev",
        metadataUri: "https://example.com/meta.json",
        initialBuySol: 0.5,
        marketCapSol: 28,
        detectedAt: "2026-11-13T20:01:00.000Z",
      },
      status: "failed",
      screenings: [SCREENING_VIEW],
      momentum: [{ at: "2026-11-13T20:05:00.000Z", score: 21, components, metrics }],
    });
  });

  it("answers 404 TOKEN_NOT_FOUND for an unknown token", async () => {
    const { base } = await start();

    const response = await fetch(`${base}/api/tokens/11111111111111111111111111111111`);

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("TOKEN_NOT_FOUND");
  });

  it("answers 400 INVALID_MINT for a malformed mint", async () => {
    const { base } = await start();

    const response = await fetch(`${base}/api/tokens/not-a-mint!`);

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("INVALID_MINT");
  });

  it("answers 400 INVALID_MINT for a mint with broken percent-encoding", async () => {
    const { base } = await start();

    for (const path of ["/api/tokens/%", "/api/tokens/%E0%A4%A"]) {
      const response = await fetch(`${base}${path}`);
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("INVALID_MINT");
    }
  });

  it("answers 400 BAD_REQUEST for a request target that is not a valid URL", async () => {
    const { base } = await start();

    const raw = await rawRequest(base, "GET http://[::1 HTTP/1.1");

    expect(raw.split("\r\n")[0]).toBe("HTTP/1.1 400 Bad Request");
    expect(raw).toContain('{"error":{"code":"BAD_REQUEST","message":"Request target is not a valid URL"}}');
  });

  it("keeps CORS, preflight, 405 and 404 for paths with broken percent-encoding", async () => {
    const { base } = await start();
    const statusOf = (raw: string) => raw.split("\r\n")[0];
    const origin = "Origin: http://localhost:5173";

    const getMint = await rawRequest(base, `GET /api/tokens/%ZZ HTTP/1.1\r\n${origin}`);
    const getCandles = await rawRequest(base, `GET /api/tokens/%ZZ/candles HTTP/1.1\r\n${origin}`);
    const preflight = await rawRequest(base, `OPTIONS /api/tokens/%ZZ HTTP/1.1\r\n${origin}`);
    const preflightRoot = await rawRequest(base, "OPTIONS /%ZZ HTTP/1.1");
    const post = await rawRequest(base, "POST /api/tokens/%ZZ HTTP/1.1\r\nContent-Length: 0");
    const head = await rawRequest(base, "HEAD /api/tokens/%ZZ HTTP/1.1");
    const unknown = await rawRequest(base, "GET /api/%ZZ HTTP/1.1");
    const health = await rawRequest(base, "GET /api/health%ZZ HTTP/1.1");

    expect(statusOf(getMint)).toBe("HTTP/1.1 400 Bad Request");
    expect(getMint).toContain('"code":"INVALID_MINT"');
    expect(getMint.toLowerCase()).toContain("access-control-allow-origin: http://localhost:5173");
    expect(getCandles.toLowerCase()).toContain("access-control-allow-origin: http://localhost:5173");
    expect(getCandles).toContain('"code":"INVALID_MINT"');
    expect(statusOf(preflight)).toBe("HTTP/1.1 204 No Content");
    expect(statusOf(preflightRoot)).toBe("HTTP/1.1 204 No Content");
    expect(statusOf(post)).toBe("HTTP/1.1 405 Method Not Allowed");
    expect(statusOf(head)).toBe("HTTP/1.1 405 Method Not Allowed");
    expect(statusOf(unknown)).toBe("HTTP/1.1 404 Not Found");
    expect(unknown).toContain('"code":"NOT_FOUND"');
    expect(statusOf(health)).toBe("HTTP/1.1 404 Not Found");
  });

  it("answers 400 INVALID_QUERY for a page number beyond the safe integer range", async () => {
    const { base } = await start();

    const response = await fetch(`${base}/api/tokens?page=99999999999999999999`);

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("INVALID_QUERY");
  });

  it("closes cleanly even if events arrive while streams are closing", async () => {
    const { feed, base } = await start({ heartbeatMs: 1 });
    const response = await fetch(`${base}/api/stream`);
    const reader = response.body!.getReader();
    await reader.read();

    const closing = app!.close();
    feed.tokenDetected(token);
    feed.sourceStatusChanged("solanaLogs", "connected");
    await closing;
    await new Promise((resolve) => setTimeout(resolve, 10));
    app = null;

    expect(() => feed.tokenDetected(token)).not.toThrow();
  });

  it("answers 404 NOT_FOUND for unknown routes and 405 for other methods", async () => {
    const { base } = await start();

    const missing = await fetch(`${base}/api/nope`);
    const post = await fetch(`${base}/api/movers`, { method: "POST" });

    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("NOT_FOUND");
    expect(post.status).toBe(405);
    expect((await post.json()).error.code).toBe("METHOD_NOT_ALLOWED");
  });

  it("answers 500 INTERNAL_ERROR without leaking the cause", async () => {
    const { history, base } = await start();
    history.fail = true;

    const response = await fetch(`${base}/api/screenings`);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Unexpected server error" },
    });
  });

  it("answers 500 INTERNAL_ERROR when a token history cannot be read", async () => {
    const { history, base } = await start();
    history.fail = true;

    const response = await fetch(`${base}/api/tokens/${MINT}`);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Unexpected server error" },
    });
  });

  it("allows only the configured browser origins", async () => {
    const { base } = await start();

    const allowed = await fetch(`${base}/api/health`, { headers: { origin: "http://localhost:5173" } });
    const denied = await fetch(`${base}/api/health`, { headers: { origin: "https://evil.example" } });
    const preflight = await fetch(`${base}/api/health`, {
      method: "OPTIONS",
      headers: { origin: "http://localhost:5173", "access-control-request-method": "GET" },
    });

    expect(allowed.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect(allowed.headers.get("vary")).toBe("Origin");
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
  });

  it("streams the current status on connect and live events after", async () => {
    const { feed, base } = await start();

    const response = await fetch(`${base}/api/stream`);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    setTimeout(() => {
      feed.tokenDetected(token);
      qualify(feed);
    }, 20);

    const text = await readSse(response, (t) => t.includes("event: token"));

    expect(text).toContain(
      'event: status\ndata: {"sources":{"pumpportal":"connecting","solanaLogs":"connecting"}}\n\n',
    );
    expect(text).toContain(`event: token\ndata: ${JSON.stringify({
      mint: MINT,
      symbol: "MON",
      name: "Monitoring",
      creator: "dev",
      metadataUri: "https://example.com/meta.json",
      initialBuySol: 0.5,
      marketCapSol: 28,
      detectedAt: "2026-11-13T20:01:00.000Z",
    })}\n\n`);
  });

  it("streams screening and momentum events as views", async () => {
    const { feed, base } = await start();
    feed.tokenDetected(token);
    qualify(feed);

    const response = await fetch(`${base}/api/stream`);
    setTimeout(() => {
      feed.screeningFinished({ token, status: "unverified", reason: "RugCheck responded 429" }, screening.evaluatedAt);
      feed.momentumUpdated([snapshot], snapshot.at);
    }, 20);

    const text = await readSse(response, (t) => t.includes("event: momentum"));
    const screeningData = JSON.parse(/event: screening\ndata: (.*)\n/.exec(text)?.[1] ?? "null");
    const momentumData = JSON.parse(/event: momentum\ndata: (.*)\n/.exec(text)?.[1] ?? "null");

    expect(screeningData).toEqual({
      mint: MINT,
      symbol: "MON",
      name: "Monitoring",
      status: "unverified",
      reason: "RugCheck responded 429",
      failureCodes: [],
      top10Pct: null,
      creatorPct: null,
      totalHolders: null,
      evaluatedAt: "2026-11-13T20:02:00.000Z",
      detectedAt: "2026-11-13T20:01:00.000Z",
      smartWallets: SMART,
    });
    expect(momentumData.at).toBe("2026-11-13T20:05:00.000Z");
    expect(momentumData.movers[0]).toMatchObject({ mint: MINT, status: "unverified", score: 21 });
  });

  it("hides a token's live events until a good wallet buys it, then announces it", async () => {
    const { feed, base } = await start();
    const other = { ...snapshot, mint: "Other11111111111111111111111111111111111111" };
    feed.tokenDetected({ ...token, mint: other.mint });

    const response = await fetch(`${base}/api/stream`);
    setTimeout(() => {
      feed.tokenDetected(token);
      feed.screeningFinished({ token, status: "unverified", reason: "RugCheck responded 429" }, screening.evaluatedAt);
      feed.momentumUpdated([snapshot, other], snapshot.at);
      qualify(feed);
      feed.momentumUpdated([snapshot, other], snapshot.at);
    }, 20);

    const text = await readSse(response, (t) => (t.match(/event: momentum/g) ?? []).length === 2);
    const events = [...text.matchAll(/event: (\S+)\ndata: (.*)\n/g)].map(([, name, data]) => [name, JSON.parse(data ?? "null")]);

    expect(events.map(([name]) => name)).toEqual(["status", "momentum", "token", "screening", "smart-wallet", "momentum"]);
    expect(events[1]?.[1].movers).toEqual([]);
    expect(events[2]?.[1].mint).toBe(MINT);
    expect(events[3]?.[1]).toMatchObject({ mint: MINT, status: "unverified", smartWallets: SMART });
    expect(events[5]?.[1].movers.map((m: { mint: string }) => m.mint)).toEqual([MINT]);
  });

  it("sends heartbeat comments", async () => {
    const { base } = await start({ heartbeatMs: 20 });

    const text = await readSse(await fetch(`${base}/api/stream`), (t) => t.includes(": ping"));

    expect(text).toContain(": ping\n\n");
  });

  it("stops sending events to a client after it disconnects", async () => {
    const { feed, base } = await start();
    const controller = new AbortController();
    const response = await fetch(`${base}/api/stream`, { signal: controller.signal });
    await readSse(response, (t) => t.includes("event: status"));
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(() => feed.tokenDetected(token)).not.toThrow();
    expect(streamCount()).toBe(0);
  });

  describe("routing exactly as before the Nest migration", () => {
    it("matches paths case-sensitively and without a trailing slash", async () => {
      const { base } = await start();

      for (const path of ["/api/health/", "/API/health", "/api/movers/", "/api/stats/", "/API/tokens", "/"]) {
        const response = await fetch(`${base}${path}`);
        expect(response.status, path).toBe(404);
        expect(await response.json()).toEqual({ error: { code: "NOT_FOUND", message: "Route not found" } });
      }
      const empty = await fetch(`${base}/api/tokens/`);
      expect(empty.status).toBe(400);
      expect((await empty.json()).error.code).toBe("INVALID_MINT");
    });

    it("resolves dot segments and absolute-form targets like a URL", async () => {
      const { base } = await start();

      for (const head of ["GET /api/x/../health HTTP/1.1", "GET http://example.com/api/health HTTP/1.1"]) {
        const raw = await rawRequest(base, head);
        expect(raw.split("\r\n")[0], head).toBe("HTTP/1.1 200 OK");
        expect(raw).toContain('"status":"ok"');
      }
    });

    it("answers 405 for HEAD and a 204 preflight on any path", async () => {
      const { base } = await start();

      const head = await fetch(`${base}/api/health`, { method: "HEAD" });
      const preflight = await fetch(`${base}/api/nope`, { method: "OPTIONS", headers: { origin: "https://evil.example" } });

      expect(head.status).toBe(405);
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
      expect(preflight.headers.get("access-control-max-age")).toBe("600");
      expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    });

    it("reads the first of repeated query parameters", async () => {
      const { history, base } = await start();

      await fetch(`${base}/api/screenings?limit=5&limit=7`);
      await fetch(`${base}/api/tokens/${MINT}/candles?interval=5m&interval=1s`);

      expect(history.requestedLimits).toEqual([5]);
      expect(history.chartRequests.map((r) => r.intervalSeconds)).toEqual([300]);
    });

    it("answers 400 INVALID_MINT for broken percent-encoding under a token", async () => {
      const { base } = await start();

      for (const path of ["/api/tokens/%/candles", "/api/tokens/%E0%A4%A/stream", "/api/tokens/%/x/y"]) {
        const response = await fetch(`${base}${path}`);
        expect(response.status, path).toBe(400);
        expect((await response.json()).error.code).toBe("INVALID_MINT");
      }
    });

    it("sends JSON with CORS headers and no framework headers, errors included", async () => {
      const { base } = await start();

      for (const path of ["/api/health", "/api/nope"]) {
        const response = await fetch(`${base}${path}`, { headers: { origin: "http://localhost:5173" } });
        expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
        expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
        expect(response.headers.get("vary")).toBe("Origin");
        expect(response.headers.get("x-powered-by")).toBeNull();
        expect(response.headers.get("etag")).toBeNull();
      }
    });

    it("reports the cause of a 500 without sending it", async () => {
      const { history, reported, base } = await start();
      history.fail = true;

      await fetch(`${base}/api/screenings`);

      expect(reported).toHaveLength(1);
      expect((reported[0] as Error).message).toBe("disk on fire");
    });

    it("starts the feed stream with exactly the retry hint and the status event", async () => {
      const { base } = await start();

      const text = await readSse(await fetch(`${base}/api/stream`), (t) => t.includes("event: status"));

      expect(text).toBe('retry: 5000\n\nevent: status\ndata: {"sources":{"pumpportal":"connecting","solanaLogs":"connecting"}}\n\n');
    });
  });

  describe("public visibility rule", () => {
    it("answers 404 TOKEN_NOT_FOUND everywhere for a token without a good wallet, until one buys it", async () => {
      const { feed, history, base } = await start();
      history.publicMints.clear();
      const paths = [`/api/tokens/${MINT}`, `/api/tokens/${MINT}/candles`, `/api/tokens/${MINT}/snapshots`, `/api/tokens/${MINT}/smart-wallets`];

      for (const path of paths) {
        const response = await fetch(`${base}${path}`);
        expect([path, response.status, (await response.json()).error.code]).toEqual([path, 404, "TOKEN_NOT_FOUND"]);
      }
      feed.tokenDetected(token);
      qualify(feed);

      for (const path of paths.slice(0, 3)) expect([path, (await fetch(`${base}${path}`)).status]).toEqual([path, 200]);
      expect((await fetch(`${base}/api/stats`)).status).toBe(200);
    });

    // Updated for D7: the visibility floor moved from minSmartWallets to minConvictionWallets.
    it("lists only tokens, screenings and movers with at least one conviction wallet, whatever minConvictionWallets says", async () => {
      const { feed, history, base } = await start();
      feed.tokenDetected(token);
      feed.momentumUpdated([snapshot], snapshot.at);

      expect((await (await fetch(`${base}/api/movers?minConvictionWallets=0`)).json()).movers).toEqual([]);
      await fetch(`${base}/api/tokens`);
      await fetch(`${base}/api/tokens?minConvictionWallets=0`);
      await fetch(`${base}/api/tokens?minConvictionWallets=3`);
      await fetch(`${base}/api/tokens?minSmartWallets=4`);
      expect(history.listQueries.map((q) => [q.minConvictionWallets, q.minSmartWallets])).toEqual([
        [1, 0],
        [1, 0],
        [3, 0],
        [1, 4],
      ]);
      await fetch(`${base}/api/screenings?minConvictionWallets=0`);
      await fetch(`${base}/api/screenings?minConvictionWallets=2&minSmartWallets=5`);
      expect([history.screeningConvictionMinimums, history.screeningMinimums]).toEqual([
        [1, 2],
        [0, 5],
      ]);
      expect((await fetch(`${base}/api/movers?minConvictionWallets=1.5`)).status).toBe(400);
      expect((await fetch(`${base}/api/screenings?minConvictionWallets=x`)).status).toBe(400);
      expect((await (await fetch(`${base}/api/tokens?minConvictionWallets=two`)).json()).error).toEqual({
        code: "INVALID_QUERY",
        message: 'Invalid query parameter "minConvictionWallets": expected an integer',
      });
    });
  });

  describe("token list, snapshots and stats", () => {
    it("lists tokens from the history with their latest state and the total", async () => {
      const { history, base } = await start();

      const response = await fetch(`${base}/api/tokens`);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        tokens: [
          {
            token: {
              mint: MINT,
              symbol: "MON",
              name: "Monitoring",
              creator: "dev",
              metadataUri: "https://example.com/meta.json",
              initialBuySol: 0.5,
              marketCapSol: 28,
              detectedAt: "2026-11-13T20:01:00.000Z",
            },
            status: "passed",
            lifecycle: "active",
            liquidity: { sol: 12.5, bondingCurvePct: 40.25, migrated: false },
            lastPriceSol: 0.00000004,
            lastMarketCapSol: 40,
            peakMarketCapSol: 90,
            maxScore: 63,
            holders: 61,
            lastTradeAt: "2026-11-13T20:30:00.000Z",
            snapshotCount: 5,
            smartWallets: { count: 3, elite: 1, holding: 2, conviction: 2 },
          },
        ],
        page: 1,
        pageSize: 50,
        total: 51,
      });
      expect(history.listQueries[0]).toMatchObject({ page: 1, pageSize: 50, sort: { field: "detectedAt", direction: "desc" } });
    });

    it("passes every filter through, with unencoded commas and colons", async () => {
      const { history, base } = await start();

      const response = await fetch(
        `${base}/api/tokens?from=2026-11-01T05:00:00.000Z&to=2026-11-02T05:00:00.000Z&status=passed,pending&lifecycle=active&minScore=40&q=mon&sort=maxScore:desc&page=2&pageSize=500`,
      );

      expect(response.status).toBe(200);
      expect((await response.json()).pageSize).toBe(200);
      expect(history.listQueries[0]).toMatchObject({
        from: new Date("2026-11-01T05:00:00.000Z"),
        to: new Date("2026-11-02T05:00:00.000Z"),
        statuses: ["passed", "pending"],
        lifecycle: "active",
        minScore: 40,
        search: "mon",
        sort: { field: "maxScore", direction: "desc" },
        page: 2,
        pageSize: 200,
      });
    });

    it("answers 400 INVALID_QUERY naming the parameter", async () => {
      const { base } = await start();

      const response = await fetch(`${base}/api/tokens?sort=price:desc`);

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: {
          code: "INVALID_QUERY",
          message: 'Invalid query parameter "sort": expected one of detectedAt, maxScore, peakMarketCapSol, liquidity with :asc or :desc',
        },
      });
    });

    it("returns the snapshots of a token, oldest first", async () => {
      const { base } = await start();

      const response = await fetch(`${base}/api/tokens/${MINT}/snapshots`);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        mint: MINT,
        lifecycle: "active",
        snapshots: [
          {
            milestone: "0m",
            at: "2026-11-13T20:01:03.000Z",
            priceSol: 0.00000003,
            marketCapSol: 30,
            volumeSol: 0.5,
            buys: 1,
            sells: 0,
            uniqueBuyers: 1,
            holders: null,
            top10Pct: null,
            devHoldsPct: null,
            liquidity: { sol: 1.5, bondingCurvePct: 4.25, migrated: false },
            source: "trades",
          },
        ],
      });
    });

    it("answers 404 TOKEN_NOT_FOUND and 400 INVALID_MINT for snapshots like the token history", async () => {
      const { base } = await start();

      const unknown = await fetch(`${base}/api/tokens/11111111111111111111111111111111/snapshots`);
      const malformed = await fetch(`${base}/api/tokens/not-a-mint/snapshots`);

      expect(unknown.status).toBe(404);
      expect((await unknown.json()).error.code).toBe("TOKEN_NOT_FOUND");
      expect(malformed.status).toBe(400);
      expect((await malformed.json()).error.code).toBe("INVALID_MINT");
    });

    it("returns the stats", async () => {
      const { base } = await start();

      expect(await (await fetch(`${base}/api/stats`)).json()).toEqual({
        since: "2026-11-13T20:01:00.000Z",
        tokens: { total: 3, active: 2, dead: 1, migrated: 1 },
        screenings: { passed: 1, failed: 1, unverified: 0, pending: 1 },
        trades: 40,
        snapshots: 7,
      });
    });

    it("answers 500 INTERNAL_ERROR when the list cannot be read", async () => {
      const { history, base } = await start();
      history.fail = true;

      for (const path of ["/api/tokens", `/api/tokens/${MINT}/snapshots`, "/api/stats"]) {
        const response = await fetch(`${base}${path}`);
        expect(response.status, path).toBe(500);
        expect((await response.json()).error.code).toBe("INTERNAL_ERROR");
      }
    });
  });

  describe("token candles", () => {
    it("returns candles, dev trades, total supply and the SOL/USD price", async () => {
      const { solPrice, base } = await start();
      solPrice.price = 142.31;

      const response = await fetch(`${base}/api/tokens/${MINT}/candles?interval=1s&limit=50`);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.json()).toEqual({
        mint: MINT,
        interval: "1s",
        totalSupply: 1_000_000_000,
        solUsd: 142.31,
        candles: [
          {
            time: Date.parse("2026-11-13T20:01:00.000Z") / 1000,
            open: 0.00003,
            high: 0.00005,
            low: 0.00002,
            close: 0.00004,
            volumeSol: 3,
            buyVolumeSol: 2,
            sellVolumeSol: 1,
            trades: 7,
          },
        ],
        devTrades: [{ time: Date.parse("2026-11-13T20:01:02.000Z") / 1000, side: "sell", solAmount: 1.5 }],
      });
    });

    it("defaults to 1m and 300 candles and reports an unknown SOL/USD price as null", async () => {
      const { history, base } = await start();

      const body = await (await fetch(`${base}/api/tokens/${MINT}/candles`)).json();

      expect(body).toMatchObject({ interval: "1m", solUsd: null });
      expect(history.chartRequests).toEqual([{ mint: MINT, intervalSeconds: 60, limit: 300 }]);
    });

    it("maps each interval to its bucket size in seconds", async () => {
      const { history, base } = await start();

      for (const interval of ["1s", "1m", "5m"]) await fetch(`${base}/api/tokens/${MINT}/candles?interval=${interval}`);

      expect(history.chartRequests.map((r) => r.intervalSeconds)).toEqual([1, 60, 300]);
    });

    it("clamps the limit to 1..1000 and falls back to 300 for invalid ones", async () => {
      const { history, base } = await start();

      for (const limit of ["5000", "0", "-3", "abc", "1000", "1"]) {
        await fetch(`${base}/api/tokens/${MINT}/candles?limit=${limit}`);
      }

      expect(history.chartRequests.map((r) => r.limit)).toEqual([1000, 1, 1, 300, 1000, 1]);
    });

    it("answers 400 INVALID_INTERVAL for any other interval", async () => {
      const { history, base } = await start();

      for (const interval of ["15m", "", "1M", "60"]) {
        const response = await fetch(`${base}/api/tokens/${MINT}/candles?interval=${interval}`);
        expect(response.status).toBe(400);
        expect((await response.json()).error.code).toBe("INVALID_INTERVAL");
      }
      expect(history.chartRequests).toEqual([]);
    });

    it("answers 404 TOKEN_NOT_FOUND and 400 INVALID_MINT like the token history", async () => {
      const { base } = await start();

      const unknown = await fetch(`${base}/api/tokens/11111111111111111111111111111111/candles`);
      const malformed = await fetch(`${base}/api/tokens/not-a-mint!/candles`);

      expect(unknown.status).toBe(404);
      expect((await unknown.json()).error.code).toBe("TOKEN_NOT_FOUND");
      expect(malformed.status).toBe(400);
      expect((await malformed.json()).error.code).toBe("INVALID_MINT");
    });

    it("answers 500 INTERNAL_ERROR when candles cannot be read", async () => {
      const { history, base } = await start();
      history.fail = true;

      const response = await fetch(`${base}/api/tokens/${MINT}/candles`);

      expect(response.status).toBe(500);
      expect((await response.json()).error.code).toBe("INTERNAL_ERROR");
    });

    it("applies CORS like the other routes", async () => {
      const { base } = await start();

      const response = await fetch(`${base}/api/tokens/${MINT}/candles`, { headers: { origin: "http://localhost:5173" } });

      expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    });

    it("still answers 400 INVALID_MINT for other paths under a token", async () => {
      const { base } = await start();

      for (const path of [`/api/tokens/${MINT}/other`, `/api/tokens/${MINT}/`, `/api/tokens/${MINT}/candles/x`]) {
        const response = await fetch(`${base}${path}`);
        expect(response.status).toBe(400);
        expect((await response.json()).error.code).toBe("INVALID_MINT");
      }
    });
  });

  describe("token stream", () => {
    it("sends the known SOL/USD price on connect, then this token's trades only", async () => {
      const { feed, solPrice, base } = await start();
      solPrice.price = 142.31;
      feed.tokenDetected(token);

      const response = await fetch(`${base}/api/tokens/${MINT}/stream`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      setTimeout(() => {
        feed.tradeRecorded(trade({ mint: "OtherMint111111111111111111111111111" }));
        feed.tradeRecorded(trade({ trader: "dev", side: "sell", signature: "devSig" }));
      }, 20);

      const text = await readSse(response, (t) => t.includes("event: trade"));

      expect(text.startsWith("retry: 5000\n\n")).toBe(true);
      expect(text).toContain('event: sol-price\ndata: {"solUsd":142.31}\n\n');
      expect(text).toContain(
        `event: trade\ndata: ${JSON.stringify({
          signature: "devSig",
          trader: "dev",
          side: "sell",
          solAmount: 0.25,
          tokenAmount: 9000,
          priceSol: 0.00003,
          isDev: true,
          time: Date.parse("2026-11-13T20:01:05.000Z") / 1000,
        })}\n\n`,
      );
      expect(text.match(/event: trade/g)).toHaveLength(1);
      expect(text).not.toContain("event: status");
    });

    it("skips the initial price while unknown and sends price changes", async () => {
      const { solPrice, base } = await start();

      const response = await fetch(`${base}/api/tokens/${MINT}/stream`);
      setTimeout(() => solPrice.set(150.5), 20);

      const text = await readSse(response, (t) => t.includes("event: sol-price"));

      expect(text).toBe('retry: 5000\n\nevent: sol-price\ndata: {"solUsd":150.5}\n\n');
    });

    it("accepts a valid mint that was never seen and sends nothing until a good wallet buys it", async () => {
      const { feed, solPrice, base } = await start();
      const mint = "11111111111111111111111111111111";

      const response = await fetch(`${base}/api/tokens/${mint}/stream`);
      setTimeout(() => {
        feed.tradeRecorded(trade({ mint, signature: "hidden" }));
        solPrice.set(150);
        feed.tokenDetected({ ...token, mint });
        qualify(feed, mint);
        feed.tradeRecorded(trade({ mint, signature: "shown" }));
      }, 20);
      const text = await readSse(response, (t) => t.includes("event: trade"));

      expect(response.status).toBe(200);
      expect(text).not.toContain("hidden");
      expect(text).toBe(
        `retry: 5000\n\nevent: sol-price\ndata: {"solUsd":150}\n\nevent: trade\ndata: ${JSON.stringify(
          tradeViewOf(trade({ mint, signature: "shown" })),
        )}\n\n`,
      );
    });

    it("answers 400 INVALID_MINT for a malformed mint", async () => {
      const { base } = await start();

      const response = await fetch(`${base}/api/tokens/not-a-mint!/stream`);

      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("INVALID_MINT");
    });

    it("sends heartbeat comments", async () => {
      const { base } = await start({ heartbeatMs: 20 });

      const text = await readSse(await fetch(`${base}/api/tokens/${MINT}/stream`), (t) => t.includes(": ping"));

      expect(text).toContain(": ping\n\n");
    });

    it("detaches from trades and prices after the client disconnects", async () => {
      const { feed, solPrice, base } = await start();
      const controller = new AbortController();
      const response = await fetch(`${base}/api/tokens/${MINT}/stream`, { signal: controller.signal });
      await readSse(response, (t) => t.includes("retry"));
      expect(feed.tradeSubscriptionCount()).toBe(1);
      expect(solPrice.listeners.size).toBe(1);

      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(feed.tradeSubscriptionCount()).toBe(0);
      expect(solPrice.listeners.size).toBe(0);
      expect(streamCount()).toBe(0);
      expect(() => feed.tradeRecorded(trade())).not.toThrow();
    });

    it("closes token streams on shutdown", async () => {
      const { feed, solPrice, base } = await start();
      const response = await fetch(`${base}/api/tokens/${MINT}/stream`);
      await response.body!.getReader().read();

      await app!.close();
      app = null;

      expect(feed.tradeSubscriptionCount()).toBe(0);
      expect(solPrice.listeners.size).toBe(0);
    });
  });
});
