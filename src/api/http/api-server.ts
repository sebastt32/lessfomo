import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { HistoryReader } from "../../history/domain/history-reader.js";
import type { LiveFeed } from "../../live-feed/application/live-feed.js";
import { liveEventView, moverView, storedScreeningView, tokenHistoryView } from "../views.js";

export interface ApiServerOptions {
  readonly host: string;
  /** 0 picks a free port (useful in tests). */
  readonly port: number;
  readonly feed: LiveFeed;
  readonly history: HistoryReader;
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

/** Integers are clamped to 1..100; anything else falls back to the default. */
const parseLimit = (raw: string | null, fallback: number): number => {
  if (raw === null || !/^-?\d+$/.test(raw)) return fallback;
  return Math.min(MAX_LIMIT, Math.max(1, Number(raw)));
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
  const { feed, history, corsOrigins, startedAt } = options;
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

  const openStream = (request: IncomingMessage, response: ServerResponse): void => {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    response.write("retry: 5000\n\n");
    writeEvent(response, { name: "status", data: { sources: feed.getSources() } });

    const unsubscribe = feed.subscribe((event) => writeEvent(response, liveEventView(event)));
    const heartbeat = setInterval(() => {
      if (!response.writableEnded) response.write(": ping\n\n");
    }, heartbeatMs);

    const cleanup = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
      streams.delete(response);
    };
    streams.set(response, cleanup);
    request.on("close", cleanup);
    response.on("close", cleanup);
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
    if (path.startsWith("/api/tokens/")) {
      const mint = safeDecode(path.slice("/api/tokens/".length));
      if (mint === null || !BASE58_MINT.test(mint)) return sendError(response, 400, "INVALID_MINT", "Mint is not a base58 address");
      const tokenHistory = await history.tokenHistory(mint);
      if (tokenHistory === null) return sendError(response, 404, "TOKEN_NOT_FOUND", "Token was never seen");
      return sendJson(response, 200, tokenHistoryView(tokenHistory));
    }
    if (path === "/api/stream") return openStream(request, response);

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
