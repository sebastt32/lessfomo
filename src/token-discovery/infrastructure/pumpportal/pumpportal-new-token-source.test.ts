import { describe, expect, it, vi } from "vitest";
import type { NewToken } from "../../domain/new-token.js";
import {
  PumpPortalNewTokenSource,
  type SocketFactory,
  type SocketLike,
} from "./pumpportal-new-token-source.js";

class FakeSocket implements SocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: string[] = [];
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.onclose?.();
  }
}

const createEvent = JSON.stringify({
  signature: "sig",
  mint: "mint123",
  traderPublicKey: "creator",
  txType: "create",
  initialBuy: 0,
  solAmount: 0,
  bondingCurveKey: "curve",
  marketCapSol: 28,
  name: "Ghost",
  symbol: "GHOST",
  uri: "https://example.com/meta.json",
  pool: "pump",
});

const setup = () => {
  const sockets: FakeSocket[] = [];
  const factory: SocketFactory = () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  };
  const source = new PumpPortalNewTokenSource({
    url: "wss://example.test",
    createSocket: factory,
    initialRetryDelayMs: 100,
    maxRetryDelayMs: 400,
    now: () => new Date("2026-11-13T20:00:00.000Z"),
  });
  return { sockets, source };
};

describe("PumpPortalNewTokenSource", () => {
  it("subscribes to new token events once connected", () => {
    const { sockets, source } = setup();
    source.start(() => {});

    sockets[0]?.onopen?.();

    expect(sockets[0]?.sent).toEqual([JSON.stringify({ method: "subscribeNewToken" })]);
  });

  it("emits parsed tokens and skips non-token messages", () => {
    const { sockets, source } = setup();
    const received: NewToken[] = [];
    source.start((token) => received.push(token));
    sockets[0]?.onopen?.();

    sockets[0]?.onmessage?.({ data: JSON.stringify({ message: "subscribed" }) });
    sockets[0]?.onmessage?.({ data: createEvent });

    expect(received.map((token) => token.mint)).toEqual(["mint123"]);
  });

  it("reconnects with exponential backoff capped at the maximum delay", () => {
    vi.useFakeTimers();
    const { sockets, source } = setup();
    source.start(() => {});

    sockets[0]?.onclose?.();
    vi.advanceTimersByTime(99);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);

    sockets[1]?.onclose?.();
    vi.advanceTimersByTime(200);
    expect(sockets).toHaveLength(3);

    sockets[2]?.onclose?.();
    vi.advanceTimersByTime(400);
    expect(sockets).toHaveLength(4);

    sockets[3]?.onclose?.();
    vi.advanceTimersByTime(400);
    expect(sockets).toHaveLength(5);

    source.stop();
    vi.useRealTimers();
  });

  it("resets the backoff after a successful connection", () => {
    vi.useFakeTimers();
    const { sockets, source } = setup();
    source.start(() => {});

    sockets[0]?.onclose?.();
    vi.advanceTimersByTime(100);
    sockets[1]?.onopen?.();
    sockets[1]?.onclose?.();
    vi.advanceTimersByTime(100);

    expect(sockets).toHaveLength(3);
    source.stop();
    vi.useRealTimers();
  });

  it("does not reconnect after stop", () => {
    vi.useFakeTimers();
    const { sockets, source } = setup();
    source.start(() => {});

    source.stop();
    vi.advanceTimersByTime(10_000);

    expect(sockets[0]?.closed).toBe(true);
    expect(sockets).toHaveLength(1);
    vi.useRealTimers();
  });
});
