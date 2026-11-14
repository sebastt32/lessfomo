import { ReconnectingSocket, type SocketFactory } from "../../../shared/reconnecting-socket.js";
import type { NewToken } from "../../domain/new-token.js";
import type { NewTokenSource } from "../../domain/new-token-source.js";
import { parsePumpPortalMessage } from "./parse-pumpportal-message.js";

export type { SocketFactory, SocketLike } from "../../../shared/reconnecting-socket.js";

export interface PumpPortalNewTokenSourceOptions {
  readonly url?: string;
  readonly createSocket?: SocketFactory;
  readonly initialRetryDelayMs?: number;
  readonly maxRetryDelayMs?: number;
  readonly now?: () => Date;
  readonly onStatus?: (status: string) => void;
}

export const PUMPPORTAL_DATA_URL = "wss://pumpportal.fun/api/data";

/** Free PumpPortal Data API adapter with automatic reconnection. */
export class PumpPortalNewTokenSource implements NewTokenSource {
  private readonly now: () => Date;
  private socket: ReconnectingSocket | null = null;

  constructor(private readonly options: PumpPortalNewTokenSourceOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  start(onToken: (token: NewToken) => void): void {
    if (this.socket !== null) return;
    const { url, createSocket, initialRetryDelayMs, maxRetryDelayMs, onStatus } = this.options;
    this.socket = new ReconnectingSocket({
      url: url ?? PUMPPORTAL_DATA_URL,
      ...(createSocket && { createSocket }),
      ...(initialRetryDelayMs !== undefined && { initialRetryDelayMs }),
      ...(maxRetryDelayMs !== undefined && { maxRetryDelayMs }),
      ...(onStatus && { onStatus }),
      onOpen: (send) => send(JSON.stringify({ method: "subscribeNewToken" })),
      onMessage: (data) => {
        const token = parsePumpPortalMessage(data, this.now());
        if (token !== null) onToken(token);
      },
    });
    this.socket.start();
  }

  stop(): void {
    this.socket?.stop();
    this.socket = null;
  }
}
