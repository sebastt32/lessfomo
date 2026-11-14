import type { SolUsdListener, SolUsdPrice } from "../domain/sol-usd-price.js";
import { PUBLIC_SOL_PRICE_SOURCES, type SolPriceSource } from "./public-price-sources.js";

export interface SolPricePollerOptions {
  readonly sources?: readonly SolPriceSource[];
  readonly fetch?: typeof globalThis.fetch;
  readonly intervalMs?: number;
  /** Per-request timeout. */
  readonly timeoutMs?: number;
}

/**
 * Polls free public sources for the SOL/USD price, falling back to the next source when one
 * fails. The price is null until a poll succeeds and again whenever every source fails.
 */
export class SolPricePoller implements SolUsdPrice {
  private readonly sources: readonly SolPriceSource[];
  private readonly fetch: typeof globalThis.fetch;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly listeners = new Set<SolUsdListener>();
  private price: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(options: SolPricePollerOptions = {}) {
    this.sources = options.sources ?? PUBLIC_SOL_PRICE_SOURCES;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.intervalMs = options.intervalMs ?? 60_000;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  current(): number | null {
    return this.price;
  }

  subscribe(listener: SolUsdListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Polls right away, then every interval. */
  start(): void {
    if (this.timer !== null) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** One poll through the fallback chain. Never rejects; overlapping calls share the same poll. */
  poll(): Promise<void> {
    this.inFlight ??= this.pollSources().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async pollSources(): Promise<void> {
    let price: number | null = null;
    for (const source of this.sources) {
      price = await this.read(source);
      if (price !== null) break;
    }
    const changed = price !== null && price !== this.price;
    this.price = price;
    if (changed && price !== null) this.notify(price);
  }

  private async read(source: SolPriceSource): Promise<number | null> {
    try {
      const response = await this.fetch(source.url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        return null;
      }
      return source.parse(await response.json());
    } catch {
      return null;
    }
  }

  private notify(price: number): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(price);
      } catch {
        // A broken client must never stop price updates for everyone else.
      }
    }
  }
}
