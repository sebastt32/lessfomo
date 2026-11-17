import type { Trade } from "../../momentum/domain/trade.js";

/** Trades seen longer ago than this are forgotten, like the momentum tracker's buffer. */
const DEDUPE_MS = 5 * 60_000;

/** A public token whose trades keep being stored after its momentum window (decision D2). */
export interface ExtendedToken {
  readonly mint: string;
  readonly creator: string;
  /** When it became public; decides which tokens are kept when full. */
  readonly appearedAt: Date;
  /**
   * End of its momentum window (creation plus the tracking window). Trades stamped before it are
   * never kept here: that hour belongs to the momentum tracker alone, so the reputation close and
   * the early snapshots read exactly the trades they read without extended storage (decision D2).
   */
  readonly startsAt: Date;
  /** End of its extended window: its creation plus `PUBLIC_TRACKING_HOURS`. */
  readonly expiresAt: Date;
}

export interface ExtendedTradeStorageOptions {
  /** Most tokens extended at once; when full, the most recently appeared ones are kept. */
  readonly maxTokens: number;
}

interface ExtendedState {
  readonly creator: string;
  readonly appearedAt: number;
  readonly startsAt: number;
  readonly expiresAt: number;
  /** Trade key → trade time, to accept each trade once. */
  readonly seen: Map<string, number>;
}

const tradeKey = (trade: Trade): string => `${trade.signature}:${trade.side}:${trade.solAmount}:${trade.tokenAmount}`;

/**
 * Use case: decides which trades are stored after a token's momentum window. Only public tokens
 * are extended, until `expiresAt`; everything else about a trade (momentum, smart wallets, the
 * reputation close) is untouched. Memory is bounded by `maxTokens` and a five-minute trade buffer.
 */
export class ExtendedTradeStorage {
  private readonly tokens = new Map<string, ExtendedState>();

  constructor(private readonly options: ExtendedTradeStorageOptions) {}

  /**
   * Starts (or keeps) extending a token. When full, the token that appeared earliest is dropped,
   * which may be the new one. Returns the mints that are not extended as a result.
   */
  extend(token: ExtendedToken): string[] {
    if (this.tokens.has(token.mint)) return [];
    const state: ExtendedState = {
      creator: token.creator,
      appearedAt: token.appearedAt.getTime(),
      startsAt: token.startsAt.getTime(),
      expiresAt: token.expiresAt.getTime(),
      seen: new Map(),
    };
    if (this.tokens.size < this.options.maxTokens) {
      this.tokens.set(token.mint, state);
      return [];
    }
    let earliest: string | null = null;
    let earliestAt = state.appearedAt;
    for (const [mint, other] of this.tokens) {
      if (other.appearedAt < earliestAt) {
        earliest = mint;
        earliestAt = other.appearedAt;
      }
    }
    if (earliest === null) return [token.mint];
    this.tokens.delete(earliest);
    this.tokens.set(token.mint, state);
    return [earliest];
  }

  /** Most tokens extended at once. */
  get capacity(): number {
    return this.options.maxTokens;
  }

  has(mint: string): boolean {
    return this.tokens.has(mint);
  }

  /** Creator of an extended token, to mark its trades on the token stream. */
  creatorOf(mint: string): string | undefined {
    return this.tokens.get(mint)?.creator;
  }

  /**
   * Notes a trade. True when it belongs to an extended token, is stamped inside its extended window
   * (after the momentum window, before the expiry) and was not seen before.
   */
  record(trade: Trade): boolean {
    const state = this.tokens.get(trade.mint);
    const time = trade.timestamp.getTime();
    if (state === undefined || time >= state.expiresAt) return false;
    const key = tradeKey(trade);
    if (state.seen.has(key)) return false;
    state.seen.set(key, time);
    return time >= state.startsAt;
  }

  /** Forgets tokens whose extended window ended (returned) and trades seen more than five minutes ago. */
  prune(now: Date): string[] {
    const nowMs = now.getTime();
    const expired: string[] = [];
    for (const [mint, state] of this.tokens) {
      if (nowMs >= state.expiresAt) {
        this.tokens.delete(mint);
        expired.push(mint);
        continue;
      }
      for (const [key, time] of state.seen) if (nowMs - time >= DEDUPE_MS) state.seen.delete(key);
    }
    return expired;
  }

  size(): number {
    return this.tokens.size;
  }
}

/** Who stores a trade: the momentum window (`live`), the extended window of a public token, or nobody. */
export type TradeRoute = "live" | "extended" | "ignored";

interface LiveTradeBuffer {
  record(trade: Trade): boolean;
  isTracking(mint: string): boolean;
}

/**
 * Routes one observed trade. While the momentum tracker follows the token it decides alone, exactly
 * as before; afterwards only public tokens keep being stored. The extended storage notes every
 * trade of its tokens, so one stored live is never stored or published again after the handover.
 */
export const routeTrade = (trade: Trade, momentum: LiveTradeBuffer, extended: ExtendedTradeStorage): TradeRoute => {
  const live = momentum.record(trade);
  const kept = extended.record(trade);
  if (live) return "live";
  return kept && !momentum.isTracking(trade.mint) ? "extended" : "ignored";
};
