import { Inject, Injectable, type BeforeApplicationShutdown } from "@nestjs/common";
import type { IncomingMessage, ServerResponse } from "node:http";
import { APP_CONFIG, type AppConfig } from "../config/app-config.js";
import type { LiveFeed } from "../live-feed/application/live-feed.js";
import { LIVE_FEED } from "../live-feed/live-feed.module.js";
import type { SolUsdPrice } from "../market-price/domain/sol-usd-price.js";
import { SOL_USD_PRICE } from "../market-price/market-price.module.js";
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
 * as documented. Open streams are ended before the API closes.
 */
@Injectable()
export class LiveStreams implements BeforeApplicationShutdown {
  /** Open SSE responses and the function that detaches each one from the feed. */
  private readonly streams = new Map<ServerResponse, () => void>();
  private readonly heartbeatMs: number;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(LIVE_FEED) private readonly feed: LiveFeed,
    @Inject(SOL_USD_PRICE) private readonly solPrice: SolUsdPrice,
  ) {
    this.heartbeatMs = config.api.heartbeatMs;
  }

  /** `GET /api/stream`: the current source statuses, then every live event. */
  openFeed(request: IncomingMessage, response: ServerResponse): void {
    const { feed } = this;
    this.open(request, response, [{ name: "status", data: { sources: feed.getSources() } }], (send) => [
      feed.subscribe((event) => send(liveEventView(event))),
    ]);
  }

  /** `GET /api/tokens/:mint/stream`: the known SOL/USD price, then this token's trades and price changes. */
  openToken(request: IncomingMessage, response: ServerResponse, mint: string): void {
    const { feed, solPrice } = this;
    const solUsd = solPrice.current();
    this.open(request, response, solUsd === null ? [] : [{ name: "sol-price", data: { solUsd } }], (send) => [
      feed.subscribeTrades(mint, (live) => send({ name: "trade", data: tradeView(live) })),
      solPrice.subscribe((price) => send({ name: "sol-price", data: { solUsd: price } })),
    ]);
  }

  /** Number of open SSE connections. */
  count(): number {
    return this.streams.size;
  }

  beforeApplicationShutdown(): void {
    for (const [stream, cleanup] of [...this.streams]) {
      cleanup();
      stream.end();
    }
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
    }, this.heartbeatMs);

    const cleanup = (): void => {
      clearInterval(heartbeat);
      for (const unsubscribe of detach) unsubscribe();
      this.streams.delete(response);
    };
    this.streams.set(response, cleanup);
    request.on("close", cleanup);
    response.on("close", cleanup);
  }
}
