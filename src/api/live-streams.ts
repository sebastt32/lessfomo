import { Inject, Injectable, type BeforeApplicationShutdown } from "@nestjs/common";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthService } from "../auth/application/auth-service.js";
import { AUTH_SERVICE } from "../auth/auth.tokens.js";
import { sessionOf } from "../auth/http/request-session.js";
import { APP_CONFIG, type AppConfig } from "../config/app-config.js";
import type { LiveFeed } from "../live-feed/application/live-feed.js";
import { LIVE_FEED } from "../live-feed/live-feed.module.js";
import type { SolUsdPrice } from "../market-price/domain/sol-usd-price.js";
import { SOL_USD_PRICE } from "../market-price/market-price.module.js";
import { ApiErrors } from "./http/api-error.js";
import { TokenVisibility } from "./token-visibility.js";
import { liveEventView, tradeView } from "./views.js";

interface SseEvent {
  readonly name: string;
  readonly data: unknown;
}

const writeEvent = (response: ServerResponse, event: SseEvent): void => {
  if (!response.writableEnded) response.write(`event: ${event.name}\ndata: ${JSON.stringify(event.data)}\n\n`);
};

/**
 * Server-Sent Events streams of docs/API.md, written straight to the response so every byte stays
 * as documented. Open streams are ended before the API closes, and when their session ends
 * (sign-out, password change, expiry).
 */
@Injectable()
export class LiveStreams implements BeforeApplicationShutdown {
  /** Open SSE responses: the function that detaches each one from the feed and the session it belongs to. */
  private readonly streams = new Map<ServerResponse, { readonly cleanup: () => void; readonly tokenHash: string }>();
  private readonly heartbeatMs: number;
  private readonly stopListening: () => void;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(LIVE_FEED) private readonly feed: LiveFeed,
    @Inject(SOL_USD_PRICE) private readonly solPrice: SolUsdPrice,
    @Inject(TokenVisibility) private readonly visibility: TokenVisibility,
    @Inject(AUTH_SERVICE) private readonly auth: AuthService,
  ) {
    this.heartbeatMs = config.api.heartbeatMs;
    // Signing out or changing the password ends the streams of the deleted sessions at once.
    this.stopListening = auth.onSessionRevoked((tokenHash) => this.closeSession(tokenHash));
  }

  /** `GET /api/stream`: the current source statuses, then every live event of public tokens. */
  openFeed(request: IncomingMessage, response: ServerResponse): void {
    const { feed } = this;
    this.open(request, response, [{ name: "status", data: { sources: feed.getSources() } }], (send) => [
      feed.subscribePublic((event) => send(liveEventView(event))),
    ]);
  }

  /**
   * `GET /api/tokens/:mint/stream`: nothing until the token is public; then the known SOL/USD price,
   * then this token's trades and price changes.
   */
  openToken(request: IncomingMessage, response: ServerResponse, mint: string): void {
    const { feed, solPrice, visibility } = this;
    let visible = false;
    let closed = false;
    this.open(request, response, [], (send) => {
      const becomeVisible = (): boolean => {
        if (visible || closed) return visible;
        if (!feed.isPublic(mint)) return false;
        visible = true;
        const solUsd = solPrice.current();
        if (solUsd !== null) send({ name: "sol-price", data: { solUsd } });
        return true;
      };
      visibility
        .isPublic(mint)
        .then((stored) => {
          if (!stored || visible || closed) return;
          visible = true;
          const solUsd = solPrice.current();
          if (solUsd !== null) send({ name: "sol-price", data: { solUsd } });
        })
        .catch(() => undefined);
      return [
        feed.subscribeTrades(mint, (live) => {
          if (becomeVisible()) send({ name: "trade", data: tradeView(live) });
        }),
        solPrice.subscribe((price) => {
          if (becomeVisible()) send({ name: "sol-price", data: { solUsd: price } });
        }),
        () => {
          closed = true;
        },
      ];
    });
  }

  /** Number of open SSE connections. */
  count(): number {
    return this.streams.size;
  }

  beforeApplicationShutdown(): void {
    this.stopListening();
    for (const stream of [...this.streams.keys()]) this.close(stream);
  }

  /** Ends every stream opened with a session. */
  private closeSession(tokenHash: string): void {
    for (const [stream, entry] of [...this.streams]) if (entry.tokenHash === tokenHash) this.close(stream);
  }

  private close(stream: ServerResponse): void {
    this.streams.get(stream)?.cleanup();
    stream.end();
  }

  /**
   * Writes the retry hint and `initial` events, then whatever `attach` sends until the client
   * leaves. `attach` returns the functions that detach it again.
   */
  private open(
    request: IncomingMessage,
    response: ServerResponse,
    initial: readonly SseEvent[],
    attach: (send: (event: SseEvent) => void) => readonly (() => void)[],
  ): void {
    // The guard authenticated the request; without its session nothing is streamed.
    const session = sessionOf(request);
    if (session === null) throw ApiErrors.unauthenticated();
    const { tokenHash } = session;
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    response.write("retry: 5000\n\n");
    for (const event of initial) writeEvent(response, event);
    const detach = attach((event) => writeEvent(response, event));
    let checking = false;
    const heartbeat = setInterval(() => {
      if (!response.writableEnded) response.write(": ping\n\n");
      if (checking) return;
      checking = true;
      // A session that expired, or was deleted by another process, loses its streams here. A session
      // that cannot be checked is treated the same (fail closed); the client reconnects through the guard.
      this.auth
        .isActive(tokenHash)
        .catch(() => false)
        .then((active) => {
          checking = false;
          if (!active && this.streams.has(response)) this.close(response);
        });
    }, this.heartbeatMs);
    const cleanup = (): void => {
      clearInterval(heartbeat);
      for (const unsubscribe of detach) unsubscribe();
      this.streams.delete(response);
    };
    this.streams.set(response, { cleanup, tokenHash });
    request.on("close", cleanup);
    response.on("close", cleanup);
  }
}
