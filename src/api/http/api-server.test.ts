import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { HistoryReader, StoredScreening, TokenHistory } from "../../history/domain/history-reader.js";
import { LiveFeed } from "../../live-feed/application/live-feed.js";
import type { MomentumSnapshot } from "../../momentum/application/momentum-tracker.js";
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

class FakeHistory implements HistoryReader {
  requestedLimits: number[] = [];
  fail = false;
  recentScreenings(limit: number): StoredScreening[] {
    if (this.fail) throw new Error("disk on fire");
    this.requestedLimits.push(limit);
    return [screening];
  }
  tokenHistory(mint: string): TokenHistory | null {
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
}

let server: ApiServer | null = null;

const start = async (options: { heartbeatMs?: number } = {}) => {
  const feed = new LiveFeed();
  const history = new FakeHistory();
  server = await startApiServer({
    host: "127.0.0.1",
    port: 0,
    feed,
    history,
    corsOrigins: ["http://localhost:5173"],
    startedAt: STARTED_AT,
    ...options,
  });
  const { port } = server.address() as AddressInfo;
  return { feed, history, base: `http://127.0.0.1:${port}` };
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
});
