import type { MomentumComponents, MomentumMetrics } from "../../momentum/domain/compute-momentum.js";

export interface StoredToken {
  readonly mint: string;
  readonly symbol: string;
  readonly name: string;
  readonly creator: string;
  readonly metadataUri: string;
  readonly initialBuySol: number;
  readonly marketCapSol: number;
  readonly detectedAt: Date;
}

export interface StoredScreening {
  readonly mint: string;
  readonly symbol: string;
  readonly name: string;
  readonly status: "passed" | "failed" | "unverified";
  readonly reason: string | null;
  readonly failureCodes: readonly string[];
  readonly top10Pct: number | null;
  readonly creatorPct: number | null;
  readonly totalHolders: number | null;
  readonly evaluatedAt: Date;
}

export interface StoredMomentumPoint {
  readonly at: Date;
  readonly score: number;
  readonly components: MomentumComponents;
  readonly metrics: MomentumMetrics;
}

export interface TokenHistory {
  readonly token: StoredToken;
  /** Latest screening status, or "pending" if it was never screened. */
  readonly status: "pending" | StoredScreening["status"];
  /** Newest first. */
  readonly screenings: readonly StoredScreening[];
  /** Oldest first. */
  readonly momentum: readonly StoredMomentumPoint[];
}

/** OHLCV of every trade of one token inside one time bucket. Prices are SOL per token. */
export interface StoredCandle {
  /** Bucket start. */
  readonly start: Date;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volumeSol: number;
  readonly buyVolumeSol: number;
  readonly sellVolumeSol: number;
  readonly trades: number;
}

/** A trade made by the token creator. */
export interface StoredDevTrade {
  readonly at: Date;
  readonly side: "buy" | "sell";
  readonly solAmount: number;
}

export interface TokenChart {
  /** Oldest first; buckets without trades are omitted. */
  readonly candles: readonly StoredCandle[];
  /** Oldest first. */
  readonly devTrades: readonly StoredDevTrade[];
}

/** Port: read access to stored history. */
export interface HistoryReader {
  /** Newest first. */
  recentScreenings(limit: number): Promise<StoredScreening[]>;
  tokenHistory(mint: string): Promise<TokenHistory | null>;
  /**
   * Candles of `intervalSeconds` built from every stored trade of a token, keeping the most
   * recent `limit` buckets, plus the creator's trades. Null if the token was never seen.
   */
  tokenChart(mint: string, intervalSeconds: number, limit: number): Promise<TokenChart | null>;
}
