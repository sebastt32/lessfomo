import { liquidityFromCurve, UNKNOWN_LIQUIDITY, type Liquidity } from "../../momentum/domain/liquidity.js";
import type { Trade } from "../../momentum/domain/trade.js";
import type { MarketUpdate, TokenMarketState } from "../domain/snapshot-store.js";

/** What the trade stream says about one watched token right now. */
export interface WatchedMarket {
  readonly detectedAt: Date;
  readonly liquidity: Liquidity;
  readonly lastPriceSol: number | null;
  readonly peakPriceSol: number | null;
  readonly lastTradeAt: Date | null;
  /** Latest scheduled milestone taken, and the one during which the last new-peak event was taken. */
  readonly lastMilestone: string | null;
  readonly peakEventWindow: string | null;
}

interface Entry {
  detectedAt: number;
  liquidity: Liquidity;
  lastPriceSol: number | null;
  peakPriceSol: number | null;
  lastTradeAt: number | null;
  lastMilestone: string | null;
  peakEventWindow: string | null;
  /** Changed since the last drain. */
  dirty: boolean;
  /** A new highest price since the last check. */
  peakRaised: boolean;
  /** The curve completed and the migration event is not taken yet. */
  migrationSeen: boolean;
}

interface RecentTrade {
  readonly priceSol: number;
  readonly at: number;
  readonly liquidity: Liquidity | null;
}

export interface MarketWatchOptions {
  /** Most tokens watched at once; the oldest detected are dropped first. */
  readonly maxWatched?: number;
  /** Latest trade of not-yet-detected mints kept, for trades that arrive before the token. */
  readonly maxRecentUnknown?: number;
  /** A watched token without trades for this long is dropped. */
  readonly idleMs?: number;
}

/**
 * Bounded in-memory view of the latest price, liquidity and peak of every watched token, fed by
 * every pump.fun trade (not only the stored ones), so state stays fresh after the live window.
 */
export class MarketWatch {
  private readonly entries = new Map<string, Entry>();
  private readonly recentUnknown = new Map<string, RecentTrade>();
  private readonly maxWatched: number;
  private readonly maxRecentUnknown: number;
  private readonly idleMs: number;

  constructor(options: MarketWatchOptions = {}) {
    this.maxWatched = options.maxWatched ?? 50_000;
    this.maxRecentUnknown = options.maxRecentUnknown ?? 5_000;
    this.idleMs = options.idleMs ?? 24 * 3_600_000;
  }

  /** Starts watching a token, from its stored state and any trade seen just before it was detected. */
  watch(mint: string, detectedAt: Date, state: Partial<TokenMarketState> & { readonly creationPriceSol?: number }): void {
    const peaks = [state.peakPriceSol, state.creationPriceSol].filter((p): p is number => typeof p === "number");
    const existing = this.entries.get(mint);
    if (existing !== undefined) {
      // Already watched: only learn what the store knows better, without raising events.
      const storedPeak = state.peakPriceSol ?? null;
      if (storedPeak !== null && (existing.peakPriceSol === null || storedPeak > existing.peakPriceSol)) {
        existing.peakPriceSol = storedPeak;
      }
      existing.lastMilestone ??= state.lastMilestone ?? null;
      existing.peakEventWindow ??= state.peakEventWindow ?? null;
      if (existing.liquidity.sol === null && state.liquidity !== undefined) {
        existing.liquidity = { ...state.liquidity, migrated: existing.liquidity.migrated || state.liquidity.migrated };
      }
      return;
    }
    if (this.entries.size >= this.maxWatched) this.dropOldest();
    const entry: Entry = {
      detectedAt: detectedAt.getTime(),
      liquidity: state.liquidity ?? UNKNOWN_LIQUIDITY,
      lastPriceSol: state.lastPriceSol ?? null,
      peakPriceSol: peaks.length > 0 ? Math.max(...peaks) : null,
      lastTradeAt: state.lastTradeAt?.getTime() ?? null,
      lastMilestone: state.lastMilestone ?? null,
      peakEventWindow: state.peakEventWindow ?? null,
      dirty: false,
      peakRaised: false,
      migrationSeen: false,
    };
    this.entries.set(mint, entry);
    const early = this.recentUnknown.get(mint);
    if (early !== undefined) {
      this.recentUnknown.delete(mint);
      this.apply(entry, early);
    }
  }

  observe(trade: Trade): void {
    const recent: RecentTrade = {
      priceSol: trade.priceSol,
      at: trade.timestamp.getTime(),
      liquidity: trade.curve === undefined ? null : liquidityFromCurve(trade.curve),
    };
    const entry = this.entries.get(trade.mint);
    if (entry !== undefined) {
      this.apply(entry, recent);
      return;
    }
    this.recentUnknown.delete(trade.mint);
    if (this.recentUnknown.size >= this.maxRecentUnknown) {
      const oldest = this.recentUnknown.keys().next().value;
      if (oldest !== undefined) this.recentUnknown.delete(oldest);
    }
    this.recentUnknown.set(trade.mint, recent);
  }

  get(mint: string): WatchedMarket | null {
    const entry = this.entries.get(mint);
    if (entry === undefined) return null;
    return {
      detectedAt: new Date(entry.detectedAt),
      liquidity: entry.liquidity,
      lastPriceSol: entry.lastPriceSol,
      peakPriceSol: entry.peakPriceSol,
      lastTradeAt: entry.lastTradeAt === null ? null : new Date(entry.lastTradeAt),
      lastMilestone: entry.lastMilestone,
      peakEventWindow: entry.peakEventWindow,
    };
  }

  /**
   * Market facts from a source other than trades (DexScreener). Its peaks are reported like
   * trade peaks; a migration it reports is handled by the caller, so it raises no event here.
   */
  quoted(mint: string, priceSol: number, liquidity: Liquidity | null): void {
    const entry = this.entries.get(mint);
    if (entry === undefined) return;
    this.raisePeak(entry, priceSol);
    if (liquidity !== null) this.setLiquidity(entry, liquidity, false);
  }

  scheduled(mint: string, milestone: string): void {
    const entry = this.entries.get(mint);
    if (entry !== undefined) entry.lastMilestone = milestone;
  }

  peakEventTaken(mint: string, window: string): void {
    const entry = this.entries.get(mint);
    if (entry !== undefined) entry.peakEventWindow = window;
  }

  /** Changes since the last drain, as store updates. */
  drainUpdates(): MarketUpdate[] {
    const updates: MarketUpdate[] = [];
    for (const [mint, entry] of this.entries) {
      if (!entry.dirty) continue;
      entry.dirty = false;
      const lastTradeAt = entry.lastTradeAt === null ? null : new Date(entry.lastTradeAt);
      updates.push({
        mint,
        lastPriceSol: entry.lastPriceSol,
        peakPriceSol: entry.peakPriceSol,
        lastTradeAt,
        lastActivityAt: lastTradeAt,
        liquidity: entry.liquidity,
      });
    }
    return updates;
  }

  /** Tokens whose curve completed since the last call. */
  takeMigrations(): string[] {
    const mints: string[] = [];
    for (const [mint, entry] of this.entries) {
      if (!entry.migrationSeen) continue;
      entry.migrationSeen = false;
      mints.push(mint);
    }
    return mints;
  }

  /** Tokens that reached a new highest price since the last call. */
  takeNewPeaks(): string[] {
    const mints: string[] = [];
    for (const [mint, entry] of this.entries) {
      if (!entry.peakRaised) continue;
      entry.peakRaised = false;
      mints.push(mint);
    }
    return mints;
  }

  forget(mint: string): void {
    this.entries.delete(mint);
  }

  /** Drops tokens without trades (or detection) for `idleMs`. */
  prune(now: Date): void {
    for (const [mint, entry] of this.entries) {
      if (now.getTime() - (entry.lastTradeAt ?? entry.detectedAt) >= this.idleMs) this.entries.delete(mint);
    }
  }

  size(): number {
    return this.entries.size;
  }

  private apply(entry: Entry, trade: RecentTrade): void {
    if (entry.lastTradeAt === null || trade.at >= entry.lastTradeAt) {
      entry.lastTradeAt = trade.at;
      entry.lastPriceSol = trade.priceSol;
      if (trade.liquidity !== null) this.setLiquidity(entry, trade.liquidity, true);
    }
    this.raisePeak(entry, trade.priceSol);
    entry.dirty = true;
  }

  private raisePeak(entry: Entry, priceSol: number): void {
    if (entry.peakPriceSol !== null && priceSol <= entry.peakPriceSol) return;
    entry.peakPriceSol = priceSol;
    entry.peakRaised = true;
    entry.dirty = true;
  }

  private setLiquidity(entry: Entry, liquidity: Liquidity, fromTrade: boolean): void {
    if (fromTrade && liquidity.migrated && !entry.liquidity.migrated) entry.migrationSeen = true;
    entry.liquidity = { ...liquidity, migrated: entry.liquidity.migrated || liquidity.migrated };
    entry.dirty = true;
  }

  private dropOldest(): void {
    let oldest: string | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [mint, entry] of this.entries) {
      if (entry.detectedAt < oldestAt) {
        oldest = mint;
        oldestAt = entry.detectedAt;
      }
    }
    if (oldest !== null) this.entries.delete(oldest);
  }
}
