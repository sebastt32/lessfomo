/** Minimal WebSocket surface, so sockets can be faked in tests. */
export interface SocketLike {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}

export type SocketFactory = (url: string) => SocketLike;

export const defaultSocketFactory: SocketFactory = (url) => new WebSocket(url) as unknown as SocketLike;

export interface ReconnectingSocketOptions {
  readonly url: string;
  readonly createSocket?: SocketFactory;
  readonly initialRetryDelayMs?: number;
  readonly maxRetryDelayMs?: number;
  /** Called on every (re)connection, typically to send subscriptions. */
  readonly onOpen: (send: (data: string) => void) => void;
  readonly onMessage: (data: string) => void;
  readonly onStatus?: (status: string) => void;
}

/** WebSocket that reconnects with capped exponential backoff until stopped. */
export class ReconnectingSocket {
  private readonly createSocket: SocketFactory;
  private readonly initialRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly onStatus: (status: string) => void;

  private socket: SocketLike | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelayMs: number;
  private running = false;

  constructor(private readonly options: ReconnectingSocketOptions) {
    this.createSocket = options.createSocket ?? defaultSocketFactory;
    this.initialRetryDelayMs = options.initialRetryDelayMs ?? 1_000;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 30_000;
    this.onStatus = options.onStatus ?? (() => {});
    this.retryDelayMs = this.initialRetryDelayMs;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
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

  private connect(): void {
    const socket = this.createSocket(this.options.url);
    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.retryDelayMs = this.initialRetryDelayMs;
      this.options.onOpen((data) => socket.send(data));
      this.onStatus("connected");
    };

    socket.onmessage = (event) => {
      if (this.socket !== socket || typeof event.data !== "string") return;
      this.options.onMessage(event.data);
    };

    socket.onerror = () => {
      if (this.socket === socket) this.onStatus("error");
    };

    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.running) this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    const delay = this.retryDelayMs;
    this.onStatus(`disconnected, retrying in ${delay}ms`);
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, this.maxRetryDelayMs);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.running) this.connect();
    }, delay);
  }
}
