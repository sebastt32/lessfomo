import type { Trade } from "../../momentum/domain/trade.js";
import { NO_STATS, round2, roundSol, type ReputationStats } from "../domain/closed-result.js";
import { styleOf, tierOf, type ReputationRules, type WalletRecord, type WalletStyle, type WalletTier } from "../domain/reputation-rules.js";
import { applyTrade, isHolding, type WalletPosition } from "../domain/wallet-positions.js";
import {
  NO_SMART_WALLETS,
  type SmartWalletEntry,
  type SmartWalletInToken,
  type SmartWalletsSummary,
  type WalletBuy,
} from "../domain/wallet-reputation-store.js";

/** A good-or-elite wallet bought or fully sold a token. */
export interface SmartWalletChange {
  readonly mint: string;
  readonly smartWallets: SmartWalletsSummary;
  readonly wallet: SmartWalletInToken;
}

export interface SmartWalletTrackerOptions {
  /** How long after its creation a token is followed (same window as the momentum tracker). */
  readonly trackingWindowMs: number;
  readonly rules: ReputationRules;
  /**
   * Point-in-time stats of each wallet at its buy, from the stored results (closed strictly
   * before the buy, within the lookback, `excludedMint` left out): the same query that rates the
   * token's smart wallets when it closes, so live and closed tiers agree by construction.
   */
  readonly statsAtBuys: (buys: readonly WalletBuy[], excludedMint: string) => Promise<Map<string, ReputationStats>>;
  /** At most this many good-or-elite records are kept in memory, only to describe a wallet. */
  readonly maxRecords?: number;
  readonly onChange: (change: SmartWalletChange) => void;
  /** Stores the latest state of a smart wallet in a token; must not throw. */
  readonly persist: (mint: string, entry: SmartWalletEntry) => void;
}

export interface SmartTrackedToken {
  readonly mint: string;
  readonly creator: string;
  readonly detectedAt: Date;
}

interface SmartPosition {
  readonly tier: Exclude<WalletTier, "none">;
  readonly style: WalletStyle;
  /** Record when it was rated, used if the current one was dropped since. */
  readonly record: WalletRecord;
  position: WalletPosition;
}

interface TokenState {
  readonly creator: string;
  readonly detectedAt: Date;
  readonly expiresAt: number;
  /** Every wallet that already bought, so a later tier never rewrites its first buy. */
  readonly buyers: Set<string>;
  /** First buys not rated yet: results closed before them may still be missing. */
  readonly pending: Map<string, WalletPosition>;
  readonly smart: Map<string, SmartPosition>;
}

/** Describes a wallet without a stored record by its stats at the buy. */
const recordAtBuy = (address: string, tier: WalletTier, style: WalletStyle, stats: ReputationStats, at: Date): WalletRecord => ({
  address,
  tier,
  isBot: false,
  tokens: stats.tokens,
  wins: stats.wins,
  winRate: stats.tokens === 0 ? 0 : round2((stats.wins / stats.tokens) * 100),
  netPnlSol: stats.netPnlSol,
  avgPnlSol: stats.tokens === 0 ? 0 : roundSol(stats.netPnlSol / stats.tokens),
  medianEntrySeconds: null,
  style,
  flipRate: stats.tokens === 0 ? null : round2((stats.flips / stats.tokens) * 100),
  medianHoldSeconds: null,
  lastActiveAt: null,
  updatedAt: at,
});

const DEFAULT_MAX_RECORDS = 200_000;

/**
 * Use case: counts, live, the good-or-elite wallets buying each tracked token. A wallet counts
 * with its exact point-in-time tier at its first buy of the token (decision D2), never a cached
 * current tier: a first buy waits until every result closed before it is stored (`rateThrough`),
 * then is rated with the same stored stats the close uses. The creator never counts; trades at or
 * after the end of the window are ignored, as when the token closes.
 */
export class SmartWalletTracker {
  private readonly records = new Map<string, WalletRecord>();
  private readonly tokens = new Map<string, TokenState>();

  constructor(private readonly options: SmartWalletTrackerOptions) {}

  /** Keeps good-or-elite records (only to describe wallets, never to rate a buy) and forgets the others. */
  updateRecords(records: readonly WalletRecord[]): void {
    const max = this.options.maxRecords ?? DEFAULT_MAX_RECORDS;
    for (const record of records) {
      if (record.tier === "none") this.records.delete(record.address);
      else if (this.records.has(record.address) || this.records.size < max) this.records.set(record.address, record);
    }
  }

  track(token: SmartTrackedToken): void {
    if (this.tokens.has(token.mint)) return;
    this.tokens.set(token.mint, {
      creator: token.creator,
      detectedAt: token.detectedAt,
      expiresAt: token.detectedAt.getTime() + this.options.trackingWindowMs,
      buyers: new Set(),
      pending: new Map(),
      smart: new Map(),
    });
  }

  /** Follows a stored trade of a tracked token. */
  tradeRecorded(trade: Trade): void {
    const state = this.tokens.get(trade.mint);
    if (state === undefined || trade.trader === state.creator || trade.timestamp.getTime() >= state.expiresAt) return;

    const known = state.smart.get(trade.trader);
    if (known !== undefined) {
      const wasHolding = isHolding(known.position);
      known.position = applyTrade(known.position, trade, 0) ?? known.position;
      const fullySold = wasHolding && !isHolding(known.position);
      this.changed(trade.mint, state, trade.trader, known, trade.side === "buy" || fullySold);
      return;
    }
    const waiting = state.pending.get(trade.trader);
    if (waiting !== undefined) {
      state.pending.set(trade.trader, applyTrade(waiting, trade, 0) ?? waiting);
      return;
    }
    if (trade.side !== "buy" || state.buyers.has(trade.trader)) return;
    const position = applyTrade(undefined, trade, 0);
    if (position === undefined) return;
    state.buyers.add(trade.trader);
    state.pending.set(trade.trader, position);
  }

  /**
   * Every result closed up to `completeThrough` is stored: rates the first buys made up to then
   * with their point-in-time tiers, then forgets the `closed` tokens (their stored smart wallets
   * are final). Called by the reputation closer after each tick.
   */
  async rateThrough(completeThrough: Date | null, closed: readonly string[] = []): Promise<void> {
    if (completeThrough !== null) {
      const end = completeThrough.getTime();
      for (const [mint, state] of [...this.tokens]) {
        const buys = [...state.pending.values()]
          .filter(({ firstBuyAt }) => firstBuyAt.getTime() <= end)
          .sort((a, b) => a.firstBuyAt.getTime() - b.firstBuyAt.getTime() || a.wallet.localeCompare(b.wallet))
          .map(({ wallet, firstBuyAt }): WalletBuy => ({ wallet, at: firstBuyAt }));
        if (buys.length === 0) continue;
        const stats = await this.options.statsAtBuys(buys, mint);
        for (const { wallet, at } of buys) this.rate(mint, state, wallet, stats.get(wallet) ?? NO_STATS, at);
      }
    }
    for (const mint of closed) this.tokens.delete(mint);
  }

  summary(mint: string): SmartWalletsSummary {
    const state = this.tokens.get(mint);
    if (state === undefined) return NO_SMART_WALLETS;
    let elite = 0;
    let holding = 0;
    let conviction = 0;
    for (const { tier, style, position } of state.smart.values()) {
      if (tier === "elite") elite += 1;
      if (isHolding(position)) holding += 1;
      if (style === "conviction") conviction += 1;
    }
    return { count: state.smart.size, elite, holding, conviction };
  }

  /** Forgets tokens whose window ended and whose first buys are all rated (or one more window later). */
  prune(now: Date): void {
    const nowMs = now.getTime();
    for (const [mint, state] of this.tokens) {
      const ended = nowMs >= state.expiresAt;
      if (ended && (state.pending.size === 0 || nowMs >= state.expiresAt + this.options.trackingWindowMs)) this.tokens.delete(mint);
    }
  }

  trackedCount(): number {
    return this.tokens.size;
  }

  recordCount(): number {
    return this.records.size;
  }

  private rate(mint: string, state: TokenState, wallet: string, stats: ReputationStats, at: Date): void {
    const position = state.pending.get(wallet);
    if (position === undefined) return;
    state.pending.delete(wallet);
    const tier = tierOf(stats, this.options.rules);
    if (tier === "none") return;
    // Same point-in-time stats as the close, so live and stored styles agree by construction (D7).
    const style = styleOf(stats, this.options.rules);
    const record = this.records.get(wallet) ?? recordAtBuy(wallet, tier, style, stats, at);
    const entry: SmartPosition = { tier, style, record, position };
    state.smart.set(wallet, entry);
    this.changed(mint, state, wallet, entry, true);
  }

  private changed(mint: string, state: TokenState, wallet: string, smart: SmartPosition, notify: boolean): void {
    const { position, tier, style } = smart;
    const entry: SmartWalletEntry = {
      wallet,
      tierAtEntry: tier,
      styleAtEntry: style,
      firstBuyAt: position.firstBuyAt,
      entrySeconds: Math.max(0, position.firstBuyAt.getTime() - state.detectedAt.getTime()) / 1000,
      boughtSol: roundSol(position.boughtSol),
      soldSol: roundSol(position.soldSol),
      stillHolding: isHolding(position),
    };
    this.options.persist(mint, entry);
    if (!notify) return;
    const record = this.records.get(wallet) ?? smart.record;
    this.options.onChange({ mint, smartWallets: this.summary(mint), wallet: { ...entry, record } });
  }
}
