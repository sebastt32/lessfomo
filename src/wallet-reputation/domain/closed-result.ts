/**
 * Result of one wallet in one token, fixed when the token's live tracking window ends: realized
 * SOL from sells, plus the remaining tokens valued at the last observed price, minus bought SOL.
 */
export interface ClosedResult {
  readonly mint: string;
  readonly firstBuyAt: Date;
  /** First sell after the first buy and before `closedAt` (decision D7); null when it never sold in the window. */
  readonly firstSellAt: Date | null;
  /** Seconds from the token's creation to the wallet's first buy. */
  readonly entrySeconds: number;
  readonly boughtSol: number;
  readonly soldSol: number;
  readonly pnlSol: number;
  /** End of the token's live tracking window. */
  readonly closedAt: Date;
}

/** Aggregates of the closed results that rate a wallet. */
export interface ReputationStats {
  readonly tokens: number;
  readonly wins: number;
  readonly netPnlSol: number;
  /** Tokens first sold within the flip window of the first buy (decision D7). */
  readonly flips: number;
}

export const NO_STATS: ReputationStats = { tokens: 0, wins: 0, netPnlSol: 0, flips: 0 };

/** Rounds SOL amounts so float noise never changes what is stored or compared. */
export const roundSol = (value: number): number => Math.round(value * 1e9) / 1e9;

export const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Median of the values; null when there are none. */
export const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
