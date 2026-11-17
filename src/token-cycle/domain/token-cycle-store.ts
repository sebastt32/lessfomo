import type { CycleSample } from "./cycle-analysis.js";
import type { CycleState, SnapshotPoint, TradeCursor, TradePoint } from "./token-cycle.js";

/** A cycle as stored: everything needed to keep folding it after a restart. */
export interface StoredCycle {
  readonly state: CycleState;
  /** Every price stored when the cycle was created has been folded once. */
  readonly caughtUp: boolean;
  readonly updatedAt: Date;
}

/** A token whose cycle is followed. */
export interface CycleToken {
  readonly mint: string;
  readonly creator: string;
  readonly detectedAt: Date;
}

/** A public token with a stored cycle. */
export interface FollowedCycle extends CycleToken {
  readonly appearedAt: Date;
}

/** Position in the list of public tokens without a caught-up cycle (newest first). */
export interface CycleBacklogCursor {
  readonly detectedAt: Date;
  readonly mint: string;
}

/** Port: stored cycles of public tokens and the prices they are folded from. */
export interface TokenCycleStore {
  /** Null if the token was never stored. */
  cycleToken(mint: string): Promise<CycleToken | null>;
  /**
   * When the token became public: the first buy of the conviction wallet (style at entry) that
   * made its count reach `minConvictionWallets`, from the stored smart wallets. Null if it never did.
   */
  appearanceAt(mint: string, minConvictionWallets: number): Promise<Date | null>;
  /**
   * Stores an empty cycle that appeared at `appearedAt`, unless the token already has one: the
   * moment a token appeared is stored once and never changes. Returns the stored cycle.
   */
  createCycle(mint: string, appearedAt: Date, now: Date): Promise<{ readonly cycle: StoredCycle; readonly created: boolean }>;
  tokenCycle(mint: string): Promise<StoredCycle | null>;
  /** Replaces everything but `appearedAt` in an existing cycle. */
  saveCycle(mint: string, state: CycleState, caughtUp: boolean, updatedAt: Date): Promise<void>;
  /** Stored trades of a token after the cursor, oldest first (insertion order inside a timestamp), numbered. */
  cycleTrades(mint: string, after: TradeCursor | null, limit: number): Promise<TradePoint[]>;
  /** Prices of the token's stored snapshots taken after `after`, oldest first, one per moment. */
  cycleSnapshots(mint: string, after: Date | null, limit: number): Promise<SnapshotPoint[]>;
  /**
   * Stored tokens with at least `minConvictionWallets` conviction wallets and no caught-up cycle,
   * newest first, after `before`.
   */
  tokensMissingCycle(minConvictionWallets: number, before: CycleBacklogCursor | null, limit: number): Promise<CycleToken[]>;
  /** Cycles of tokens detected after `detectedAfter`, most recently appeared first. */
  recentCycles(detectedAfter: Date, limit: number): Promise<FollowedCycle[]>;
  /** Cycles that appeared in [`from`, `to`). */
  cycleSamples(from: Date, to: Date): Promise<CycleSample[]>;
}
