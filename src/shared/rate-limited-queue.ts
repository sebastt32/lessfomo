export interface RateLimitedQueueOptions<T> {
  /** Minimum time between the start of two consecutive jobs. */
  readonly minIntervalMs: number;
  /** Maximum pending items; when full, the oldest pending item is dropped. */
  readonly maxSize: number;
  readonly process: (item: T) => Promise<void>;
  readonly onDrop?: (item: T) => void;
  readonly onError?: (item: T, error: unknown) => void;
}

/** Runs jobs one at a time, never faster than the given interval, favouring fresh items. */
export class RateLimitedQueue<T> {
  private pending: T[] = [];
  private busy = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: RateLimitedQueueOptions<T>) {}

  enqueue(item: T): void {
    if (this.pending.length >= this.options.maxSize) {
      const dropped = this.pending.shift();
      if (dropped !== undefined) this.options.onDrop?.(dropped);
    }
    this.pending.push(item);
    this.runNext();
  }

  clear(): void {
    this.pending = [];
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private runNext(): void {
    if (this.busy || this.timer !== null || this.pending.length === 0) return;
    const item = this.pending.shift() as T;
    this.busy = true;
    const startedAt = Date.now();

    void this.options
      .process(item)
      .catch((error: unknown) => this.options.onError?.(item, error))
      .finally(() => {
        this.busy = false;
        const wait = Math.max(0, this.options.minIntervalMs - (Date.now() - startedAt));
        this.timer = setTimeout(() => {
          this.timer = null;
          this.runNext();
        }, wait);
      });
  }
}
