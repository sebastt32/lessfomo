import type { Liquidity } from "../../momentum/domain/liquidity.js";
import type { TokenSnapshot, TradeWindow } from "./assemble-snapshot.js";

/** What is known about a token's market and its snapshot schedule. */
export interface TokenMarketState {
  readonly liquidity: Liquidity;
  readonly lastPriceSol: number | null;
  readonly peakPriceSol: number | null;
  /** Latest trade seen in the trade stream. */
  readonly lastTradeAt: Date | null;
  /** Latest moment the token is known to have traded, from any source (decides "dead"). */
  readonly lastActivityAt: Date | null;
  readonly holders: number | null;
  /** Highest holder milestone (100, 500, 1000) already snapshotted; 0 for none. */
  readonly holderThreshold: number;
  /** Latest scheduled milestone taken; null before the first one. */
  readonly lastMilestone: string | null;
  /** Scheduled milestone during which the latest `event:new-peak` was taken. */
  readonly peakEventWindow: string | null;
}

/** A token whose next scheduled snapshot is due. */
export interface DueToken {
  readonly mint: string;
  readonly symbol: string;
  readonly creator: string;
  readonly bondingCurve: string;
  readonly detectedAt: Date;
  /** Price implied by the market cap at creation. */
  readonly creationPriceSol: number;
  readonly nextMilestone: string;
  readonly lastSnapshotAt: Date | null;
  readonly market: TokenMarketState;
}

/** A token still on schedule, to keep watching its trades after a restart. */
export interface WatchedToken {
  readonly mint: string;
  readonly detectedAt: Date;
  readonly market: TokenMarketState;
}

/** Latest market facts seen for a token; nulls leave the stored value unchanged. */
export interface MarketUpdate {
  readonly mint: string;
  readonly lastPriceSol: number | null;
  /** Kept only if higher than the stored peak. */
  readonly peakPriceSol: number | null;
  /** Kept only if later than the stored one. */
  readonly lastTradeAt: Date | null;
  /** Kept only if later than the stored one. */
  readonly lastActivityAt: Date | null;
  /** Null leaves the stored liquidity; once migrated, a token stays migrated. */
  readonly liquidity: Liquidity | null;
}

/** How storing a snapshot moves the token's schedule and event markers. */
export interface SnapshotStateChange {
  /** The next scheduled milestone, or null to stop the schedule. Absent leaves it unchanged. */
  readonly next?: { readonly milestone: string; readonly at: Date } | null;
  /** Set when the snapshot is a scheduled one. */
  readonly lastMilestone?: string;
  readonly peakEventWindow?: string;
  readonly holderThreshold?: number;
}

export interface SnapshotHolders {
  readonly holders: number;
  readonly top10Pct: number;
  readonly devHoldsPct: number;
}

/** Port: durable snapshot schedule and snapshots, so a restart resumes where it stopped. */
export interface SnapshotStore {
  /** Tokens whose next snapshot is due at `now`, earliest first. */
  dueTokens(now: Date, limit: number): Promise<DueToken[]>;
  /** Tokens still on schedule detected since `since`, newest first. */
  watchedTokens(since: Date, limit: number): Promise<WatchedToken[]>;
  /** Stored trades of a token in (`after`, `upTo`], plus the latest price up to `upTo`. */
  tradeWindow(mint: string, after: Date | null, upTo: Date): Promise<TradeWindow>;
  /** Stores the snapshot (once per mint, milestone and time) and applies the state change atomically. */
  saveSnapshot(snapshot: TokenSnapshot, change: SnapshotStateChange): Promise<void>;
  /** Stops the schedule of a token that has been dead for 24 hours. */
  markDead(mint: string): Promise<void>;
  updateMarkets(updates: readonly MarketUpdate[]): Promise<void>;
  /** Adds holder data to a stored snapshot and keeps it as the token's latest holder count. */
  addSnapshotHolders(mint: string, milestone: string, at: Date, holders: SnapshotHolders): Promise<void>;
}
