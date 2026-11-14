import { connect, type AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type {
  HistoryReader,
  StoredScreening,
  TokenChart,
  TokenHistory,
} from "../../history/domain/history-reader.js";
import { LiveFeed } from "../../live-feed/application/live-feed.js";
import type { SolUsdListener, SolUsdPrice } from "../../market-price/domain/sol-usd-price.js";
import type { MomentumSnapshot } from "../../momentum/application/momentum-tracker.js";
import type { Trade } from "../../momentum/domain/trade.js";
import type { NewToken } from "../../token-discovery/domain/new-token.js";
import { startApiServer, type ApiServer } from "./api-server.js";

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

class FakeHistory implements HistoryReader {
  requestedLimits: number[] = [];
  chartRequests: { mint: string; intervalSeconds: number; limit: number }[] = [];
  fail = false;
  async recentScreenings(limit: number): Promise<StoredScreening[]> {
    if (this.fail) throw new Error("disk on fire");
    this.requestedLimits.push(limit);
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
}

let server: ApiServer | null = null;

const start = async (options: { heartbeatMs?: number } = {}) => {
  const feed = new LiveFeed();
  const history = new FakeHistory();
  const solPrice = new FakeSolPrice();
  server = await startApiServer({
    host: "127.0.0.1",
    port: 0,
    feed,
    history,
    solPrice,
    corsOrigins: ["http://localhost:5173"],
    startedAt: STARTED_AT,
    ...options,
  });
  const { port } = server.address() as AddressInfo;
  return { feed, history, solPrice, base: `http://127.0.0.1:${port}` };
};

afterEach(async () => {
  await server?.close();
  server = null;
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

describe("API server", () => {
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
        },
      ],
    });
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
      screenings: [{ ...screening, evaluatedAt: "2026-11-13T20:02:00.000Z" }],
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
      screenings: [{ ...screening, evaluatedAt: "2026-11-13T20:02:00.000Z" }],
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
    const { port } = new URL(base);

    const statusLine = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(port), "127.0.0.1", () => {
        socket.write("GET http://[::1 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
      });
      let raw = "";
      socket.on("data", (chunk) => (raw += chunk.toString()));
      socket.on("end", () => resolve(raw.split("\r\n")[0] ?? ""));
      socket.on("error", reject);
    });

    expect(statusLine).toBe("HTTP/1.1 400 Bad Request");
  });

  it("closes cleanly even if events arrive while streams are closing", async () => {
    const { feed, base } = await start({ heartbeatMs: 1 });
    const response = await fetch(`${base}/api/stream`);
    const reader = response.body!.getReader();
    await reader.read();

    const closing = server!.close();
    feed.tokenDetected(token);
    feed.sourceStatusChanged("solanaLogs", "connected");
    await closing;
    await new Promise((resolve) => setTimeout(resolve, 10));
    server = null;

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
    setTimeout(() => feed.tokenDetected(token), 20);

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
    });
    expect(momentumData.at).toBe("2026-11-13T20:05:00.000Z");
    expect(momentumData.movers[0]).toMatchObject({ mint: MINT, status: "unverified", score: 21 });
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
    expect(server?.streamCount()).toBe(0);
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

    it("accepts a valid mint that was never seen", async () => {
      const { feed, base } = await start();

      const response = await fetch(`${base}/api/tokens/11111111111111111111111111111111/stream`);
      setTimeout(() => feed.tradeRecorded(trade({ mint: "11111111111111111111111111111111" })), 20);
      const text = await readSse(response, (t) => t.includes("event: trade"));

      expect(response.status).toBe(200);
      expect(text).toContain('"isDev":false');
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
      expect(server?.streamCount()).toBe(0);
      expect(() => feed.tradeRecorded(trade())).not.toThrow();
    });

    it("closes token streams on shutdown", async () => {
      const { feed, solPrice, base } = await start();
      const response = await fetch(`${base}/api/tokens/${MINT}/stream`);
      await response.body!.getReader().read();

      await server!.close();
      server = null;

      expect(feed.tradeSubscriptionCount()).toBe(0);
      expect(solPrice.listeners.size).toBe(0);
    });
  });
});
