export interface CycleEventThrottleOptions<T> {
  /** Least time between two non-urgent events of the same token. */
  readonly minIntervalMs: number;
  readonly send: (mint: string, value: T) => void;
}

interface Entry<T> {
  sentAt: number;
  /** Latest value waiting for the interval to end. */
  pending: T | null;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Entries are swept once this many tokens are remembered. */
const SWEEP_ABOVE = 2_000;

/**
 * Limits the `cycle` events of each token: urgent ones (the token appears, its phase changes) are
 * sent at once; the others (a new peak) at most once per interval, the latest when it ends.
 */
export class CycleEventThrottle<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private stopped = false;

  constructor(private readonly options: CycleEventThrottleOptions<T>) {}

  offer(mint: string, value: T, urgent: boolean): void {
    if (this.stopped) return;
    const now = Date.now();
    const entry = this.entries.get(mint);
    if (urgent || entry === undefined || now - entry.sentAt >= this.options.minIntervalMs) {
      if (entry?.timer != null) clearTimeout(entry.timer);
      this.entries.set(mint, { sentAt: now, pending: null, timer: null });
      this.sweep(now);
      this.options.send(mint, value);
      return;
    }
    entry.pending = value;
    entry.timer ??= setTimeout(() => this.flush(mint), entry.sentAt + this.options.minIntervalMs - now);
    entry.timer.unref?.();
  }

  /** Drops every waiting event; nothing is sent afterwards. */
  stop(): void {
    this.stopped = true;
    for (const entry of this.entries.values()) if (entry.timer !== null) clearTimeout(entry.timer);
    this.entries.clear();
  }

  private flush(mint: string): void {
    const entry = this.entries.get(mint);
    if (entry === undefined) return;
    entry.timer = null;
    const value = entry.pending;
    if (value === null) return;
    entry.pending = null;
    entry.sentAt = Date.now();
    this.options.send(mint, value);
  }

  /** Forgets tokens whose interval ended with nothing waiting, to bound memory. */
  private sweep(now: number): void {
    if (this.entries.size <= SWEEP_ABOVE) return;
    for (const [mint, entry] of this.entries) {
      if (entry.timer === null && now - entry.sentAt >= this.options.minIntervalMs) this.entries.delete(mint);
    }
  }
}
