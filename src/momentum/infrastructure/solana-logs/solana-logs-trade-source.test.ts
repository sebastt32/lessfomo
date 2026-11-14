import { describe, expect, it } from "vitest";
import type { SocketLike } from "../../../shared/reconnecting-socket.js";
import type { Trade } from "../../domain/trade.js";
import fixture from "./__fixtures__/pump-sell-logs.json" with { type: "json" };
import { SolanaLogsTradeSource } from "./solana-logs-trade-source.js";

class FakeSocket implements SocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.onclose?.();
  }
}

const setup = () => {
  const sockets: FakeSocket[] = [];
  const source = new SolanaLogsTradeSource({
    url: "wss://example.test",
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  return { sockets, source };
};

describe("SolanaLogsTradeSource", () => {
  it("subscribes to pump.fun program logs once connected", () => {
    const { sockets, source } = setup();
    source.start(() => {});

    sockets[0]?.onopen?.();

    expect(JSON.parse(sockets[0]?.sent[0] ?? "{}")).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "logsSubscribe",
      params: [{ mentions: ["6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"] }, { commitment: "confirmed" }],
    });
  });

  it("emits trades from log notifications and ignores other messages", () => {
    const { sockets, source } = setup();
    const trades: Trade[] = [];
    source.start((trade) => trades.push(trade));
    sockets[0]?.onopen?.();

    sockets[0]?.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", result: 42, id: 1 }) });
    sockets[0]?.onmessage?.({ data: "not json" });
    sockets[0]?.onmessage?.({
      data: JSON.stringify({
        jsonrpc: "2.0",
        method: "logsNotification",
        params: { result: { context: { slot: 1 }, value: fixture }, subscription: 42 },
      }),
    });

    expect(trades.map((t) => t.signature)).toEqual([fixture.signature]);
  });

  it("stops emitting after stop", () => {
    const { sockets, source } = setup();
    const trades: Trade[] = [];
    source.start((trade) => trades.push(trade));
    sockets[0]?.onopen?.();

    source.stop();
    sockets[0]?.onmessage?.({
      data: JSON.stringify({ method: "logsNotification", params: { result: { value: fixture } } }),
    });

    expect(trades).toEqual([]);
  });
});
