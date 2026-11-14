import type { NewToken } from "../../domain/new-token.js";
import type { NewTokenSource } from "../../domain/new-token-source.js";
import { parsePumpPortalMessage } from "./parse-pumpportal-message.js";

/** Minimal WebSocket surface used by the source, so it can be faked in tests. */
export interface SocketLike {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}

export type SocketFactory = (url: string) => SocketLike;

export interface PumpPortalNewTokenSourceOptions {
  readonly url?: string;
  readonly createSocket?: SocketFactory;
  readonly initialRetryDelayMs?: number;
  readonly maxRetryDelayMs?: number;
  readonly now?: () => Date;
  readonly onStatus?: (status: string) => void;
}

export const PUMPPORTAL_DATA_URL = "wss://pumpportal.fun/api/data";

const defaultSocketFactory: SocketFactory = (url) => new WebSocket(url) as unknown as SocketLike;

/** Free PumpPortal Data API adapter with automatic reconnection. */
export class PumpPortalNewTokenSource implements NewTokenSource {
  private readonly url: string;
  private readonly createSocket: SocketFactory;
  private readonly initialRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly now: () => Date;
  private readonly onStatus: (status: string) => void;

  private socket: SocketLike | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelayMs: number;
  private running = false;

  constructor(options: PumpPortalNewTokenSourceOptions = {}) {
    this.url = options.url ?? PUMPPORTAL_DATA_URL;
    this.createSocket = options.createSocket ?? defaultSocketFactory;
    this.initialRetryDelayMs = options.initialRetryDelayMs ?? 1_000;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 30_000;
    this.now = options.now ?? (() => new Date());
    this.onStatus = options.onStatus ?? (() => {});
    this.retryDelayMs = this.initialRetryDelayMs;
  }

  start(onToken: (token: NewToken) => void): void {
    if (this.running) return;
    this.running = true;
    this.connect(onToken);
  }

  stop(): void {
    this.running = false;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  private connect(onToken: (token: NewToken) => void): void {
    const socket = this.createSocket(this.url);
    this.socket = socket;

    socket.onopen = () => {
      this.retryDelayMs = this.initialRetryDelayMs;
      socket.send(JSON.stringify({ method: "subscribeNewToken" }));
      this.onStatus("connected");
    };

    socket.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      const token = parsePumpPortalMessage(event.data, this.now());
      if (token !== null) onToken(token);
    };

    socket.onerror = () => {
      this.onStatus("error");
    };

    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.running) this.scheduleReconnect(onToken);
    };
  }

  private scheduleReconnect(onToken: (token: NewToken) => void): void {
    const delay = this.retryDelayMs;
    this.onStatus(`disconnected, retrying in ${delay}ms`);
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, this.maxRetryDelayMs);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.running) this.connect(onToken);
    }, delay);
  }
}
