import { computeMomentum, type Momentum } from "../domain/compute-momentum.js";
import type { Trade } from "../domain/trade.js";

/** Trades older than this are no longer needed to compute momentum. */
const BUFFER_MS = 5 * 60_000;

export interface TrackedToken {
  readonly mint: string;
  readonly creator: string;
}

export interface MomentumSnapshot {
  readonly mint: string;
  readonly at: Date;
  readonly momentum: Momentum;
}

export interface MomentumTrackerOptions {
  /** How long after `track` a token keeps being followed. */
  readonly trackingWindowMs: number;
}

interface TrackedState {
  readonly creator: string;
  readonly expiresAt: number;
  trades: Trade[];
  seen: Set<string>;
}

const tradeKey = (trade: Trade): string =>
  `${trade.signature}:${trade.side}:${trade.solAmount}:${trade.tokenAmount}`;

/** Use case: keep a short trade buffer per new token and compute momentum snapshots. */
export class MomentumTracker {
  private readonly tracked = new Map<string, TrackedState>();

  constructor(private readonly options: MomentumTrackerOptions) {}

  track(token: TrackedToken, now: Date): void {
    if (this.tracked.has(token.mint)) return;
    this.tracked.set(token.mint, {
      creator: token.creator,
      expiresAt: now.getTime() + this.options.trackingWindowMs,
      trades: [],
      seen: new Set(),
    });
  }

  /** Stores a trade if its token is tracked. Returns true when the trade was stored. */
  record(trade: Trade): boolean {
    const state = this.tracked.get(trade.mint);
    if (state === undefined) return false;
    const key = tradeKey(trade);
    if (state.seen.has(key)) return false;
    state.seen.add(key);
    state.trades.push(trade);
    return true;
  }

  /** Computes momentum for every tracked token, dropping expired tokens and stale trades. */
  snapshot(now: Date): MomentumSnapshot[] {
    const nowMs = now.getTime();
    const snapshots: MomentumSnapshot[] = [];

    for (const [mint, state] of this.tracked) {
      if (nowMs >= state.expiresAt) {
        this.tracked.delete(mint);
        continue;
      }
      state.trades = state.trades.filter((t) => nowMs - t.timestamp.getTime() < BUFFER_MS);
      state.seen = new Set(state.trades.map(tradeKey));
      const momentum = computeMomentum(state.trades, now, { excludedTraders: new Set([state.creator]) });
      snapshots.push({ mint, at: now, momentum });
    }
    return snapshots;
  }

  /** The token is still followed (until the first snapshot after its window ends). */
  isTracking(mint: string): boolean {
    return this.tracked.has(mint);
  }

  trackedCount(): number {
    return this.tracked.size;
  }

  bufferedTradeCount(): number {
    let total = 0;
    for (const state of this.tracked.values()) total += state.trades.length;
    return total;
  }
}
