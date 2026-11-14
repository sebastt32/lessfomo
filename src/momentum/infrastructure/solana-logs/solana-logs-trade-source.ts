import { isObject, readObject } from "../../../shared/json.js";
import { ReconnectingSocket, type SocketFactory } from "../../../shared/reconnecting-socket.js";
import type { Trade } from "../../domain/trade.js";
import type { TradeSource } from "../../domain/trade-source.js";
import { extractPumpTrades, PUMP_PROGRAM_ID } from "./extract-pump-trades.js";

export const SOLANA_PUBLIC_WS_URL = "wss://api.mainnet-beta.solana.com";

export interface SolanaLogsTradeSourceOptions {
  readonly url?: string;
  readonly createSocket?: SocketFactory;
  readonly onStatus?: (status: string) => void;
}

const safeJsonParse = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

/** Streams every pump.fun trade from a (free) Solana RPC `logsSubscribe` WebSocket. */
export class SolanaLogsTradeSource implements TradeSource {
  private socket: ReconnectingSocket | null = null;

  constructor(private readonly options: SolanaLogsTradeSourceOptions = {}) {}

  start(onTrade: (trade: Trade) => void): void {
    if (this.socket !== null) return;
    const { url, createSocket, onStatus } = this.options;
    this.socket = new ReconnectingSocket({
      url: url ?? SOLANA_PUBLIC_WS_URL,
      ...(createSocket && { createSocket }),
      ...(onStatus && { onStatus }),
      onOpen: (send) =>
        send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "logsSubscribe",
            params: [{ mentions: [PUMP_PROGRAM_ID] }, { commitment: "confirmed" }],
          }),
        ),
      onMessage: (data) => {
        const message = safeJsonParse(data);
        if (!isObject(message) || message["method"] !== "logsNotification") return;
        const params = readObject(message, "params");
        const result = params && readObject(params, "result");
        if (result === null) return;
        for (const trade of extractPumpTrades(result["value"])) onTrade(trade);
      },
    });
    this.socket.start();
  }

  stop(): void {
    this.socket?.stop();
    this.socket = null;
  }
}
