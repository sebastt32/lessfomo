import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { HistoryReader } from "../../history/domain/history-reader.js";
import type { LiveFeed } from "../../live-feed/application/live-feed.js";
import type { SolUsdPrice } from "../../market-price/domain/sol-usd-price.js";
import {
  candleView,
  devTradeView,
  liveEventView,
  moverView,
  storedScreeningView,
  tokenHistoryView,
  tradeView,
} from "../views.js";

export interface ApiServerOptions {
  readonly host: string;
  /** 0 picks a free port (useful in tests). */
  readonly port: number;
  readonly feed: LiveFeed;
  readonly history: HistoryReader;
  readonly solPrice: SolUsdPrice;
  /** Browser origins allowed by CORS. */
  readonly corsOrigins: readonly string[];
  readonly startedAt: Date;
  readonly heartbeatMs?: number;
  readonly onError?: (error: unknown) => void;
}

export interface ApiServer {
  address(): ReturnType<Server["address"]>;
  /** Number of open SSE connections. */
  streamCount(): number;
  close(): Promise<void>;
}

const BASE58_MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DEFAULT_MOVERS_LIMIT = 20;
const DEFAULT_SCREENINGS_LIMIT = 50;
const MAX_LIMIT = 100;
const DEFAULT_CANDLES_LIMIT = 300;
const MAX_CANDLES_LIMIT = 1000;
/** pump.fun tokens always have a fixed supply of one billion. */
const PUMP_TOTAL_SUPPLY = 1_000_000_000;
const CANDLE_INTERVALS: Readonly<Record<string, number>> = { "1s": 1, "1m": 60, "5m": 300 };
const DEFAULT_CANDLE_INTERVAL = "1m";
/** `/api/tokens/<mint>/candles` and `/api/tokens/<mint>/stream`. */
const TOKEN_SUBROUTE = /^\/api\/tokens\/([^/]+)\/(candles|stream)$/;

/** Integers are clamped to 1..max (100 unless stated); anything else falls back to the default. */
const parseLimit = (raw: string | null, fallback: number, max = MAX_LIMIT): number => {
  if (raw === null || !/^-?\d+$/.test(raw)) return fallback;
  return Math.min(max, Math.max(1, Number(raw)));
};

/** The decoded mint, or null if it is not a base58 address. */
const parseMint = (raw: string): string | null => {
  const mint = safeDecode(raw);
  return mint !== null && BASE58_MINT.test(mint) ? mint : null;
};

const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
};

const sendError = (response: ServerResponse, status: number, code: string, message: string): void =>
  sendJson(response, status, { error: { code, message } });

const writeEvent = (response: ServerResponse, event: { name: string; data: unknown }): void => {
  if (!response.writableEnded) response.write(`event: ${event.name}\ndata: ${JSON.stringify(event.data)}\n\n`);
};

/** Returns null instead of throwing on malformed percent-encoding. */
const safeDecode = (value: string): string | null => {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
};

/** Starts the read-only HTTP + SSE API described in docs/API.md. */
export const startApiServer = (options: ApiServerOptions): Promise<ApiServer> => {
  const { feed, history, solPrice, corsOrigins, startedAt } = options;
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  /** Open SSE responses and the function that detaches each one from the feed. */
  const streams = new Map<ServerResponse, () => void>();

  const applyCors = (request: IncomingMessage, response: ServerResponse): void => {
    const origin = request.headers.origin;
    if (origin !== undefined && corsOrigins.includes(origin)) {
      response.setHeader("access-control-allow-origin", origin);
      response.setHeader("vary", "Origin");
    }
  };

  /**
   * Opens an SSE response: writes the retry hint and `initial` events, then whatever `attach`
   * sends until the client leaves. `attach` returns the functions that detach it again.
   */
  const openStream = (
    request: IncomingMessage,
    response: ServerResponse,
    initial: readonly { name: string; data: unknown }[],
    attach: (send: (event: { name: string; data: unknown }) => void) => readonly (() => void)[],
  ): void => {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    response.write("retry: 5000\n\n");
    for (const event of initial) writeEvent(response, event);

    const detach = attach((event) => writeEvent(response, event));
    const heartbeat = setInterval(() => {
      if (!response.writableEnded) response.write(": ping\n\n");
    }, heartbeatMs);

    const cleanup = (): void => {
      clearInterval(heartbeat);
      for (const unsubscribe of detach) unsubscribe();
      streams.delete(response);
    };
    streams.set(response, cleanup);
    request.on("close", cleanup);
    response.on("close", cleanup);
  };

  const openFeedStream = (request: IncomingMessage, response: ServerResponse): void =>
    openStream(request, response, [{ name: "status", data: { sources: feed.getSources() } }], (send) => [
      feed.subscribe((event) => send(liveEventView(event))),
    ]);

  const openTokenStream = (request: IncomingMessage, response: ServerResponse, mint: string): void => {
    const solUsd = solPrice.current();
    openStream(request, response, solUsd === null ? [] : [{ name: "sol-price", data: { solUsd } }], (send) => [
      feed.subscribeTrades(mint, (live) => send({ name: "trade", data: tradeView(live) })),
      solPrice.subscribe((price) => send({ name: "sol-price", data: { solUsd: price } })),
    ]);
  };

  const sendCandles = async (response: ServerResponse, mint: string, url: URL): Promise<void> => {
    const interval = url.searchParams.get("interval") ?? DEFAULT_CANDLE_INTERVAL;
    const intervalSeconds = Object.hasOwn(CANDLE_INTERVALS, interval) ? CANDLE_INTERVALS[interval] : undefined;
    if (intervalSeconds === undefined) {
      return sendError(response, 400, "INVALID_INTERVAL", "Interval must be one of 1s, 1m, 5m");
    }
    const limit = parseLimit(url.searchParams.get("limit"), DEFAULT_CANDLES_LIMIT, MAX_CANDLES_LIMIT);
    const chart = await history.tokenChart(mint, intervalSeconds, limit);
    if (chart === null) return sendError(response, 404, "TOKEN_NOT_FOUND", "Token was never seen");
    return sendJson(response, 200, {
      mint,
      interval,
      totalSupply: PUMP_TOTAL_SUPPLY,
      solUsd: solPrice.current(),
      candles: chart.candles.map(candleView),
      devTrades: chart.devTrades.map(devTradeView),
    });
  };

  const route = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://localhost");
    } catch {
      return sendError(response, 400, "BAD_REQUEST", "Request target is not a valid URL");
    }
    const path = url.pathname;

    if (path === "/api/health") {
      return sendJson(response, 200, { status: "ok", startedAt: startedAt.toISOString(), sources: feed.getSources() });
    }
    if (path === "/api/movers") {
      const { at, movers } = feed.getMovers(parseLimit(url.searchParams.get("limit"), DEFAULT_MOVERS_LIMIT));
      return sendJson(response, 200, { at: at?.toISOString() ?? null, movers: movers.map(moverView) });
    }
    if (path === "/api/screenings") {
      const limit = parseLimit(url.searchParams.get("limit"), DEFAULT_SCREENINGS_LIMIT);
      const screenings = await history.recentScreenings(limit);
      return sendJson(response, 200, { screenings: screenings.map(storedScreeningView) });
    }
    const subroute = TOKEN_SUBROUTE.exec(path);
    if (subroute !== null) {
      const [, rawMint = "", resource] = subroute;
      const mint = parseMint(rawMint);
      if (mint === null) return sendError(response, 400, "INVALID_MINT", "Mint is not a base58 address");
      if (resource === "candles") return sendCandles(response, mint, url);
      return openTokenStream(request, response, mint);
    }
    if (path.startsWith("/api/tokens/")) {
      const mint = parseMint(path.slice("/api/tokens/".length));
      if (mint === null) return sendError(response, 400, "INVALID_MINT", "Mint is not a base58 address");
      const tokenHistory = await history.tokenHistory(mint);
      if (tokenHistory === null) return sendError(response, 404, "TOKEN_NOT_FOUND", "Token was never seen");
      return sendJson(response, 200, tokenHistoryView(tokenHistory));
    }
    if (path === "/api/stream") return openFeedStream(request, response);

    sendError(response, 404, "NOT_FOUND", "Route not found");
  };

  const server = createServer((request, response) => {
    applyCors(request, response);

    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-max-age": "600",
      });
      response.end();
      return;
    }
    if (request.method !== "GET") {
      sendError(response, 405, "METHOD_NOT_ALLOWED", "Only GET is supported");
      return;
    }

    route(request, response).catch((error: unknown) => {
      options.onError?.(error);
      if (!response.headersSent) sendError(response, 500, "INTERNAL_ERROR", "Unexpected server error");
      else response.end();
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve({
        address: () => server.address(),
        streamCount: () => streams.size,
        close: () =>
          new Promise<void>((done) => {
            for (const [stream, cleanup] of [...streams]) {
              cleanup();
              stream.end();
            }
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
};
