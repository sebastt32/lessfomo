import type { MomentumSnapshot } from "../../momentum/application/momentum-tracker.js";
import type { Trade } from "../../momentum/domain/trade.js";
import type { ScreeningResult } from "../../screening/token-screener.js";
import type { NewToken } from "../../token-discovery/domain/new-token.js";

export type SafetyStatus = "pending" | ScreeningResult["status"];
export type SourceName = "pumpportal" | "solanaLogs";
export type SourceStatus = "connecting" | "connected" | "disconnected";
export type SourceStatuses = Readonly<Record<SourceName, SourceStatus>>;

export interface Mover {
  readonly token: NewToken;
  readonly status: SafetyStatus;
  readonly snapshot: MomentumSnapshot;
}

export type LiveEvent =
  | { readonly type: "token"; readonly token: NewToken }
  | { readonly type: "screening"; readonly result: ScreeningResult; readonly evaluatedAt: Date }
  | { readonly type: "momentum"; readonly at: Date; readonly movers: readonly Mover[] }
  | { readonly type: "status"; readonly sources: SourceStatuses };

export type LiveListener = (event: LiveEvent) => void;

export interface LiveTrade {
  readonly trade: Trade;
  /** The trader is the token creator. */
  readonly isDev: boolean;
}

export type TradeListener = (live: LiveTrade) => void;

/** Calls every listener; a broken client must never stop the feed for everyone else. */
const notifyAll = <T>(listeners: Iterable<(value: T) => void>, value: T): void => {
  for (const listener of listeners) {
    try {
      listener(value);
    } catch {
      // Ignored on purpose.
    }
  }
};

interface TokenState {
  readonly token: NewToken;
  status: SafetyStatus;
}

/** Use case: in-memory view of what is happening right now, plus an event bus for live clients. */
export class LiveFeed {
  private readonly tokens = new Map<string, TokenState>();
  private readonly listeners = new Set<LiveListener>();
  /** Per-mint trade listeners; a mint is removed with its last listener. */
  private readonly tradeListeners = new Map<string, Set<TradeListener>>();
  private movers: readonly Mover[] = [];
  private moversAt: Date | null = null;
  private sources: Record<SourceName, SourceStatus> = { pumpportal: "connecting", solanaLogs: "connecting" };

  tokenDetected(token: NewToken): void {
    if (!this.tokens.has(token.mint)) this.tokens.set(token.mint, { token, status: "pending" });
    this.emit({ type: "token", token });
  }

  screeningFinished(result: ScreeningResult, evaluatedAt: Date): void {
    const state = this.tokens.get(result.token.mint);
    if (state !== undefined) state.status = result.status;
    this.emit({ type: "screening", result, evaluatedAt });
  }

  momentumUpdated(snapshots: readonly MomentumSnapshot[], at: Date): void {
    this.movers = snapshots
      .flatMap((snapshot) => {
        const state = this.tokens.get(snapshot.mint);
        return state === undefined ? [] : [{ token: state.token, status: state.status, snapshot }];
      })
      .sort((a, b) => b.snapshot.momentum.score - a.snapshot.momentum.score);
    this.moversAt = at;
    this.emit({ type: "momentum", at, movers: this.movers });
  }

  sourceStatusChanged(source: SourceName, status: SourceStatus): void {
    if (this.sources[source] === status) return;
    this.sources = { ...this.sources, [source]: status };
    this.emit({ type: "status", sources: this.sources });
  }

  /** Translates ReconnectingSocket status messages ("connected", "disconnected, retrying…"). */
  sourceStatusFromSocket(source: SourceName, message: string): void {
    if (message === "connected") this.sourceStatusChanged(source, "connected");
    else if (message.startsWith("disconnected")) this.sourceStatusChanged(source, "disconnected");
  }

  /** Publishes a stored trade to the subscribers of its token. */
  tradeRecorded(trade: Trade): void {
    const listeners = this.tradeListeners.get(trade.mint);
    if (listeners === undefined) return;
    const creator = this.tokens.get(trade.mint)?.token.creator;
    notifyAll([...listeners], { trade, isDev: creator !== undefined && trade.trader === creator });
  }

  subscribeTrades(mint: string, listener: TradeListener): () => void {
    let listeners = this.tradeListeners.get(mint);
    if (listeners === undefined) {
      listeners = new Set();
      this.tradeListeners.set(mint, listeners);
    }
    listeners.add(listener);
    return () => {
      const current = this.tradeListeners.get(mint);
      if (current === undefined || !current.delete(listener)) return;
      if (current.size === 0) this.tradeListeners.delete(mint);
    };
  }

  /** Number of open per-token trade subscriptions. */
  tradeSubscriptionCount(): number {
    let count = 0;
    for (const listeners of this.tradeListeners.values()) count += listeners.size;
    return count;
  }

  getMovers(limit: number): { at: Date | null; movers: readonly Mover[] } {
    return { at: this.moversAt, movers: this.movers.slice(0, limit) };
  }

  getSources(): SourceStatuses {
    return this.sources;
  }

  subscribe(listener: LiveListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Drops tokens detected more than `maxAgeMs` ago, to bound memory. */
  prune(now: Date, maxAgeMs: number): void {
    for (const [mint, state] of this.tokens) {
      if (now.getTime() - state.token.detectedAt.getTime() > maxAgeMs) this.tokens.delete(mint);
    }
  }

  private emit(event: LiveEvent): void {
    notifyAll(this.listeners, event);
  }
}
