import type { ClosedResult, ReputationStats } from "./closed-result.js";
import type { WalletRecord, WalletStyle, WalletTier } from "./reputation-rules.js";
import type { TokenOutcome } from "./smart-wallet-outcome.js";
import type { ObservedTrade, WalletClosedResult } from "./wallet-positions.js";

/**
 * Good-or-elite wallets (by tier at entry) that bought a token; `holding` = still holding;
 * `conviction` = of those, the ones whose style at entry was conviction (decision D7).
 */
export interface SmartWalletsSummary {
  readonly count: number;
  readonly elite: number;
  readonly holding: number;
  readonly conviction: number;
}

export const NO_SMART_WALLETS: SmartWalletsSummary = { count: 0, elite: 0, holding: 0, conviction: 0 };

/** A good-or-elite wallet in one token. Its tier is fixed at its first buy of the token. */
export interface SmartWalletEntry {
  readonly wallet: string;
  readonly tierAtEntry: Exclude<WalletTier, "none">;
  /** Point-in-time style at the first buy, from the same results as the tier (decision D7). */
  readonly styleAtEntry: WalletStyle;
  readonly firstBuyAt: Date;
  readonly entrySeconds: number;
  readonly boughtSol: number;
  readonly soldSol: number;
  readonly stillHolding: boolean;
}

/** A smart wallet in a token, with its current record to explain why it is good. */
export interface SmartWalletInToken extends SmartWalletEntry {
  readonly record: WalletRecord;
}

export interface StoredWalletResult extends ClosedResult {
  readonly wallet: string;
  /** Empty when the token itself was never stored. */
  readonly symbol: string;
  readonly name: string;
}

/** A token whose live tracking window ended, to close its results. */
export interface ClosableToken {
  readonly mint: string;
  readonly creator: string;
  readonly detectedAt: Date;
}

/** Everything fixed when a token closes, stored atomically. */
export interface TokenClose {
  readonly mint: string;
  readonly detectedAt: Date;
  readonly closedAt: Date;
  readonly results: readonly WalletClosedResult[];
  /** Replaces the entries written live, with exact point-in-time tiers. */
  readonly smartWallets: readonly SmartWalletEntry[];
  readonly outcome: TokenOutcome | null;
  /** The same outcome counting only conviction wallets (entry after the k-th one's first buy). */
  readonly convictionOutcome?: TokenOutcome | null;
}

/** A wallet's first buy of a token, to rate it at that moment. */
export interface WalletBuy {
  readonly wallet: string;
  readonly at: Date;
}

export interface StoredOutcome {
  readonly smartWallets: number;
  readonly returnPct: number;
  readonly reached2x: boolean;
  readonly peakX: number;
  readonly migrated: boolean;
}

/** Port: stored wallet results, reputations and smart wallets per token. */
export interface WalletReputationStore {
  /**
   * Tokens detected in [`from`, `upTo`] that were not closed yet, oldest first, so every result
   * closed before a buy is stored before that buy is rated.
   */
  closableTokens(from: Date | null, upTo: Date, limit: number): Promise<ClosableToken[]>;
  /** Every stored trade of a token, oldest first (insertion order breaks ties). */
  tokenTrades(mint: string): Promise<ObservedTrade[]>;
  /** Time of the token's first safety check, or null. */
  firstScreeningAt(mint: string): Promise<Date | null>;
  /**
   * Point-in-time stats of each wallet at its buy: only results closed strictly before the buy and
   * within `lookbackMs` before it, other than `excludedMint`. Wallets without results are absent.
   */
  statsAtBuys(
    buys: readonly WalletBuy[],
    lookbackMs: number,
    excludedMint: string,
    flipWindowMs?: number,
  ): Promise<Map<string, ReputationStats>>;
  /**
   * Stores the results, smart wallets and outcomes of a token and marks it closed at the current
   * close version, in one transaction. Tokens closed at an older version are offered again by
   * `closableTokens`, oldest first, so their new fields are backfilled.
   */
  saveTokenClose(close: TokenClose): Promise<void>;
  /** Results of the wallets closed at or after `since`, newest first buy first. */
  walletResults(wallets: readonly string[], since: Date): Promise<StoredWalletResult[]>;
  hasWalletResults(wallet: string): Promise<boolean>;
  saveWalletRecords(records: readonly WalletRecord[]): Promise<void>;
  /** Wallets with recent results whose record was computed before `updatedBefore`, oldest first. */
  staleWallets(updatedBefore: Date, limit: number): Promise<string[]>;
  /** Stored records rated good or elite. */
  smartWalletRecords(limit: number): Promise<WalletRecord[]>;
  /** Stores (or replaces) one smart wallet of a token and its summary. */
  saveSmartWallet(mint: string, entry: SmartWalletEntry): Promise<void>;
  tokenSmartWallets(mint: string): Promise<SmartWalletEntry[]>;
  /** Stored smart-wallet counts of a token (zeros when it has none). */
  tokenSmartSummary(mint: string): Promise<SmartWalletsSummary>;
  /** The given mints that have at least `minSmartWallets` stored smart wallets. */
  mintsWithSmartWallets(mints: readonly string[], minSmartWallets: number): Promise<Set<string>>;
  /** The given mints that have at least `minConvictionWallets` stored conviction wallets. */
  mintsWithConvictionWallets(mints: readonly string[], minConvictionWallets: number): Promise<Set<string>>;
  /** Outcomes of closed tokens detected in [`from`, `to`). */
  smartWalletOutcomes(from: Date, to: Date): Promise<StoredOutcome[]>;
  /** Conviction-wallet outcomes of closed tokens detected in [`from`, `to`) (`smartWallets` = conviction wallets). */
  convictionOutcomes(from: Date, to: Date): Promise<StoredOutcome[]>;
}
