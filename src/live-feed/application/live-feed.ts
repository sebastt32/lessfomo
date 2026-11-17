import type { MomentumSnapshot } from "../../momentum/application/momentum-tracker.js";
import { liquidityFromCurve, UNKNOWN_LIQUIDITY, type Liquidity } from "../../momentum/domain/liquidity.js";
import type { Trade } from "../../momentum/domain/trade.js";
import type { ScreeningResult } from "../../screening/token-screener.js";
import type { TokenCycle } from "../../token-cycle/domain/token-cycle.js";
import type { NewToken } from "../../token-discovery/domain/new-token.js";
import type { SmartWalletChange } from "../../wallet-reputation/application/smart-wallet-tracker.js";
import {
  NO_SMART_WALLETS,
  type SmartWalletInToken,
  type SmartWalletsSummary,
} from "../../wallet-reputation/domain/wallet-reputation-store.js";

export type SafetyStatus = "pending" | ScreeningResult["status"];
export type SourceName = "pumpportal" | "solanaLogs";
export type SourceStatus = "connecting" | "connected" | "disconnected";
export type SourceStatuses = Readonly<Record<SourceName, SourceStatus>>;

export interface Mover {
  readonly token: NewToken;
  readonly status: SafetyStatus;
  /** Latest liquidity seen in the token's trades. */
  readonly liquidity: Liquidity;
  readonly snapshot: MomentumSnapshot;
  /** Good-or-elite wallets that bought the token so far, and how many had the conviction style. */
  readonly smartWallets: SmartWalletsSummary;
  /** The token's cycle once it appeared; absent before. */
  readonly cycle?: TokenCycle;
}

export type LiveEvent =
  | { readonly type: "token"; readonly token: NewToken }
  | {
      readonly type: "screening";
      readonly result: ScreeningResult;
      readonly evaluatedAt: Date;
      readonly smartWallets: SmartWalletsSummary;
      readonly cycle?: TokenCycle;
    }
  | { readonly type: "momentum"; readonly at: Date; readonly movers: readonly Mover[] }
  | { readonly type: "status"; readonly sources: SourceStatuses }
  | {
      readonly type: "smart-wallet";
      readonly mint: string;
      readonly smartWallets: SmartWalletsSummary;
      readonly wallet: SmartWalletInToken;
    }
  | { readonly type: "cycle"; readonly mint: string; readonly cycle: TokenCycle };

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
  liquidity: Liquidity;
  smartWallets: SmartWalletsSummary;
  lastScreening: { readonly result: ScreeningResult; readonly evaluatedAt: Date } | null;
  cycle: TokenCycle | null;
}

/** `{ cycle }` when there is one, so events and movers of tokens without a cycle stay as they were. */
const withCycle = (cycle: TokenCycle | null | undefined): { readonly cycle?: TokenCycle } => (cycle == null ? {} : { cycle });

/** Use case: in-memory view of what is happening right now, plus an event bus for live clients. */
export class LiveFeed {
  /**
   * @param publicMinConvictionWallets conviction wallets at entry a token needs before public
   * listeners hear about it (`PUBLIC_MIN_CONVICTION_WALLETS`, docs/API.md "Public visibility rule").
   */
  constructor(private readonly publicMinConvictionWallets: number) {}

  private readonly tokens = new Map<string, TokenState>();
  private readonly listeners = new Set<LiveListener>();
  private readonly publicListeners = new Set<LiveListener>();
  /** Per-mint trade listeners; a mint is removed with its last listener. */
  private readonly tradeListeners = new Map<string, Set<TradeListener>>();
  private movers: readonly Mover[] = [];
  private moversAt: Date | null = null;
  private sources: Record<SourceName, SourceStatus> = { pumpportal: "connecting", solanaLogs: "connecting" };

  tokenDetected(token: NewToken): void {
    if (!this.tokens.has(token.mint)) {
      this.tokens.set(token.mint, {
        token,
        status: "pending",
        liquidity: UNKNOWN_LIQUIDITY,
        smartWallets: NO_SMART_WALLETS,
        lastScreening: null,
        cycle: null,
      });
    }
    const event: LiveEvent = { type: "token", token };
    this.emit(event);
    if (this.isPublic(token.mint)) this.emitPublic(event);
  }

  screeningFinished(result: ScreeningResult, evaluatedAt: Date): void {
    const state = this.tokens.get(result.token.mint);
    if (state !== undefined) {
      state.status = result.status;
      state.lastScreening = { result, evaluatedAt };
    }
    const event: LiveEvent = {
      type: "screening",
      result,
      evaluatedAt,
      smartWallets: state?.smartWallets ?? NO_SMART_WALLETS,
      ...withCycle(state?.cycle),
    };
    this.emit(event);
    if (this.isPublic(result.token.mint)) this.emitPublic(event);
  }

  momentumUpdated(snapshots: readonly MomentumSnapshot[], at: Date): void {
    this.movers = snapshots
      .flatMap((snapshot) => {
        const state = this.tokens.get(snapshot.mint);
        return state === undefined
          ? []
          : [
              {
                token: state.token,
                status: state.status,
                liquidity: state.liquidity,
                snapshot,
                smartWallets: state.smartWallets,
                ...withCycle(state.cycle),
              },
            ];
      })
      .sort((a, b) => b.snapshot.momentum.score - a.snapshot.momentum.score);
    this.moversAt = at;
    this.emit({ type: "momentum", at, movers: this.movers });
    const publicMovers = this.movers.filter((mover) => this.isPublicSummary(mover.smartWallets));
    this.emitPublic({ type: "momentum", at, movers: publicMovers });
  }

  /** Keeps a token's smart-wallet counts (for movers) and publishes the change. */
  smartWalletChanged(change: SmartWalletChange): void {
    const state = this.tokens.get(change.mint);
    const becamePublic =
      state !== undefined && !this.isPublicSummary(state.smartWallets) && this.isPublicSummary(change.smartWallets);
    if (state !== undefined) state.smartWallets = change.smartWallets;
    const event: LiveEvent = { type: "smart-wallet", mint: change.mint, smartWallets: change.smartWallets, wallet: change.wallet };
    this.emit(event);
    if (becamePublic) {
      // Public clients learn about the token the moment it qualifies, then about its safety check.
      this.emitPublic({ type: "token", token: state.token });
      if (state.lastScreening !== null) {
        this.emitPublic({ type: "screening", ...state.lastScreening, smartWallets: change.smartWallets, ...withCycle(state.cycle) });
      }
    }
    if (this.isPublicSummary(change.smartWallets)) this.emitPublic(event);
  }

  sourceStatusChanged(source: SourceName, status: SourceStatus): void {
    if (this.sources[source] === status) return;
    this.sources = { ...this.sources, [source]: status };
    this.emit({ type: "status", sources: this.sources });
    this.emitPublic({ type: "status", sources: this.sources });
  }

  /** Translates ReconnectingSocket status messages ("connected", "disconnected, retrying…"). */
  sourceStatusFromSocket(source: SourceName, message: string): void {
    if (message === "connected") this.sourceStatusChanged(source, "connected");
    else if (message.startsWith("disconnected")) this.sourceStatusChanged(source, "disconnected");
  }

  /** Keeps a token's latest cycle, shown with its movers and screenings, without publishing it. */
  cycleUpdated(mint: string, cycle: TokenCycle): void {
    const state = this.tokens.get(mint);
    if (state !== undefined) state.cycle = cycle;
  }

  /**
   * Publishes the cycle of a public token (it appeared, changed phase or set a new peak). The
   * caller applies the visibility rule: the feed may have forgotten the token long ago.
   */
  cycleChanged(mint: string, cycle: TokenCycle): void {
    this.cycleUpdated(mint, cycle);
    const event: LiveEvent = { type: "cycle", mint, cycle };
    this.emit(event);
    this.emitPublic(event);
  }

  /**
   * Keeps the token's latest liquidity and publishes a stored trade to the subscribers of its
   * token. `creator` is given for trades stored after the feed forgot the token (decision D2).
   */
  tradeRecorded(trade: Trade, creator?: string): void {
    const state = this.tokens.get(trade.mint);
    if (state !== undefined && trade.curve !== undefined) {
      const liquidity = liquidityFromCurve(trade.curve);
      state.liquidity = { ...liquidity, migrated: liquidity.migrated || state.liquidity.migrated };
    }
    const listeners = this.tradeListeners.get(trade.mint);
    if (listeners === undefined) return;
    const knownCreator = state?.token.creator ?? creator;
    notifyAll([...listeners], { trade, isDev: knownCreator !== undefined && trade.trader === knownCreator });
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

  /**
   * Latest ranking with current smart-wallet counts; only movers with at least `minSmartWallets`
   * smart wallets and `minConvictionWallets` conviction wallets.
   */
  getMovers(limit: number, minSmartWallets = 0, minConvictionWallets = 0): { at: Date | null; movers: readonly Mover[] } {
    const movers = this.movers
      .map((mover) => {
        const state = this.tokens.get(mover.token.mint);
        if (state === undefined || (state.smartWallets === mover.smartWallets && (state.cycle ?? undefined) === mover.cycle)) return mover;
        return { ...mover, smartWallets: state.smartWallets, ...withCycle(state.cycle) };
      })
      .filter((mover) => mover.smartWallets.count >= minSmartWallets && mover.smartWallets.conviction >= minConvictionWallets);
    return { at: this.moversAt, movers: movers.slice(0, limit) };
  }

  getSources(): SourceStatuses {
    return this.sources;
  }

  /** Live smart-wallet counts of a token still in memory. */
  smartWalletsOf(mint: string): SmartWalletsSummary {
    return this.tokens.get(mint)?.smartWallets ?? NO_SMART_WALLETS;
  }

  /** The token has at least `publicMinConvictionWallets` live conviction wallets (flippers never count). */
  isPublic(mint: string): boolean {
    return this.isPublicSummary(this.smartWalletsOf(mint));
  }

  private isPublicSummary(summary: SmartWalletsSummary): boolean {
    return summary.conviction >= this.publicMinConvictionWallets;
  }

  /**
   * Events of public tokens only: a token appears (`token`, then its latest `screening`) when its
   * conviction-wallet count reaches `publicMinConvictionWallets`; `momentum` lists only public movers;
   * `status` is unchanged.
   */
  subscribePublic(listener: LiveListener): () => void {
    this.publicListeners.add(listener);
    return () => this.publicListeners.delete(listener);
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

  private emitPublic(event: LiveEvent): void {
    notifyAll(this.publicListeners, event);
  }

  private emit(event: LiveEvent): void {
    notifyAll(this.listeners, event);
  }
}
