import type { Trade } from "../../momentum/domain/trade.js";
import { roundSol } from "../domain/closed-result.js";
import type { WalletRecord, WalletTier } from "../domain/reputation-rules.js";
import { applyTrade, isHolding, type WalletPosition } from "../domain/wallet-positions.js";
import {
  NO_SMART_WALLETS,
  type SmartWalletEntry,
  type SmartWalletInToken,
  type SmartWalletsSummary,
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
  /** At most this many good-or-elite records are kept in memory. */
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
  /** Record at the first buy, used if the current one was dropped since. */
  readonly record: WalletRecord;
  position: WalletPosition;
}

interface TokenState {
  readonly creator: string;
  readonly detectedAt: Date;
  readonly expiresAt: number;
  /** Every wallet that already bought, so a later tier never rewrites its first buy. */
  readonly buyers: Set<string>;
  readonly smart: Map<string, SmartPosition>;
}

const DEFAULT_MAX_RECORDS = 200_000;

/**
 * Use case: counts, live, the good-or-elite wallets buying each tracked token. A wallet counts
 * with its current tier at its first buy of the token (fixed from then on); the creator never
 * counts. Exact point-in-time tiers replace these counts when the token closes.
 */
export class SmartWalletTracker {
  private readonly records = new Map<string, WalletRecord>();
  private readonly tokens = new Map<string, TokenState>();

  constructor(private readonly options: SmartWalletTrackerOptions) {}

  /** Keeps good-or-elite records and forgets the others. */
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
      smart: new Map(),
    });
  }

  /** Follows a stored trade of a tracked token. */
  tradeRecorded(trade: Trade): void {
    const state = this.tokens.get(trade.mint);
    if (state === undefined || trade.trader === state.creator) return;

    const known = state.smart.get(trade.trader);
    if (known !== undefined) {
      const wasHolding = isHolding(known.position);
      known.position = applyTrade(known.position, trade, 0) ?? known.position;
      const fullySold = wasHolding && !isHolding(known.position);
      this.changed(trade.mint, state, trade.trader, known, trade.side === "buy" || fullySold);
      return;
    }
    if (trade.side !== "buy" || state.buyers.has(trade.trader)) return;
    state.buyers.add(trade.trader);
    const record = this.records.get(trade.trader);
    if (record === undefined || record.tier === "none") return;
    const position = applyTrade(undefined, trade, 0);
    if (position === undefined) return;
    const entry: SmartPosition = { tier: record.tier, record, position };
    state.smart.set(trade.trader, entry);
    this.changed(trade.mint, state, trade.trader, entry, true);
  }

  summary(mint: string): SmartWalletsSummary {
    const state = this.tokens.get(mint);
    if (state === undefined) return NO_SMART_WALLETS;
    let elite = 0;
    let holding = 0;
    for (const { tier, position } of state.smart.values()) {
      if (tier === "elite") elite += 1;
      if (isHolding(position)) holding += 1;
    }
    return { count: state.smart.size, elite, holding };
  }

  /** Forgets tokens whose window ended. */
  prune(now: Date): void {
    for (const [mint, state] of this.tokens) if (now.getTime() >= state.expiresAt) this.tokens.delete(mint);
  }

  trackedCount(): number {
    return this.tokens.size;
  }

  recordCount(): number {
    return this.records.size;
  }

  private changed(mint: string, state: TokenState, wallet: string, smart: SmartPosition, notify: boolean): void {
    const { position, tier } = smart;
    const entry: SmartWalletEntry = {
      wallet,
      tierAtEntry: tier,
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
