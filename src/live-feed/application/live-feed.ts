import type { MomentumSnapshot } from "../../momentum/application/momentum-tracker.js";
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

interface TokenState {
  readonly token: NewToken;
  status: SafetyStatus;
}

/** Use case: in-memory view of what is happening right now, plus an event bus for live clients. */
export class LiveFeed {
  private readonly tokens = new Map<string, TokenState>();
  private readonly listeners = new Set<LiveListener>();
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
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A broken client must never stop the feed for everyone else.
      }
    }
  }
}
