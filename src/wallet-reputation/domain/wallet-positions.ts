import type { Trade } from "../../momentum/domain/trade.js";
import { roundSol, type ClosedResult } from "./closed-result.js";

export type ObservedTrade = Pick<Trade, "trader" | "side" | "solAmount" | "tokenAmount" | "priceSol" | "timestamp">;

/** What one wallet did in one token, from its first observed buy on. */
export interface WalletPosition {
  readonly wallet: string;
  readonly firstBuyAt: Date;
  /** Index of the first buy in the token's ordered trades. */
  readonly firstBuyIndex: number;
  readonly boughtSol: number;
  readonly soldSol: number;
  readonly boughtTokens: number;
  readonly soldTokens: number;
}

/** Below this, a balance is float noise left by selling everything. */
const DUST_TOKENS = 1e-6;

/** The position after one more trade of its wallet. A sell before the first buy opens nothing. */
export const applyTrade = (
  position: WalletPosition | undefined,
  trade: ObservedTrade,
  index: number,
): WalletPosition | undefined => {
  if (position === undefined) {
    if (trade.side !== "buy") return undefined;
    return {
      wallet: trade.trader,
      firstBuyAt: trade.timestamp,
      firstBuyIndex: index,
      boughtSol: trade.solAmount,
      soldSol: 0,
      boughtTokens: trade.tokenAmount,
      soldTokens: 0,
    };
  }
  return trade.side === "buy"
    ? { ...position, boughtSol: position.boughtSol + trade.solAmount, boughtTokens: position.boughtTokens + trade.tokenAmount }
    : { ...position, soldSol: position.soldSol + trade.solAmount, soldTokens: position.soldTokens + trade.tokenAmount };
};

/** Tokens still held per observed trades (decision D3). */
export const remainingTokens = (position: WalletPosition): number => Math.max(0, position.boughtTokens - position.soldTokens);

export const isHolding = (position: WalletPosition): boolean => remainingTokens(position) > DUST_TOKENS;

/** Positions of every wallet but `excludedTrader` (the token creator), in first-buy order. */
export const foldPositions = (trades: readonly ObservedTrade[], excludedTrader: string): Map<string, WalletPosition> => {
  const positions = new Map<string, WalletPosition>();
  trades.forEach((trade, index) => {
    if (trade.trader === excludedTrader) return;
    const next = applyTrade(positions.get(trade.trader), trade, index);
    if (next !== undefined) positions.set(trade.trader, next);
  });
  return positions;
};

export interface WalletClosedResult extends Omit<ClosedResult, "mint"> {
  readonly wallet: string;
}

export interface TokenResults {
  readonly results: WalletClosedResult[];
  readonly positions: Map<string, WalletPosition>;
  readonly lastPriceSol: number | null;
}

/**
 * Trades strictly before `closedAt`, the end of the token's window (decision D2: nothing after the
 * close counts, however late the close runs). Trades are ordered oldest first, so this is a prefix
 * and trade indices keep their meaning.
 */
export const tradesBefore = <T extends Pick<ObservedTrade, "timestamp">>(trades: readonly T[], closedAt: Date): T[] => {
  const end = closedAt.getTime();
  return trades.filter(({ timestamp }) => timestamp.getTime() < end);
};

/**
 * Result of every wallet that bought the token (its creator excluded, decision D1), from the
 * token's trades ordered oldest first; trades at or after `closedAt` are ignored and the
 * remaining tokens are valued at the last price before it.
 */
export const closeTokenResults = (
  allTrades: readonly ObservedTrade[],
  token: { readonly creator: string; readonly detectedAt: Date },
  closedAt: Date,
): TokenResults => {
  const trades = tradesBefore(allTrades, closedAt);
  const lastPriceSol = trades.at(-1)?.priceSol ?? null;
  const positions = foldPositions(trades, token.creator);
  const results = [...positions.values()].map((position) => ({
    wallet: position.wallet,
    firstBuyAt: position.firstBuyAt,
    entrySeconds: Math.max(0, position.firstBuyAt.getTime() - token.detectedAt.getTime()) / 1000,
    boughtSol: roundSol(position.boughtSol),
    soldSol: roundSol(position.soldSol),
    pnlSol: roundSol(position.soldSol + remainingTokens(position) * (lastPriceSol ?? 0) - position.boughtSol),
    closedAt,
  }));
  return { results, positions, lastPriceSol };
};
