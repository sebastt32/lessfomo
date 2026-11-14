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

/** Port: read access to stored history. */
export interface HistoryReader {
  /** Newest first. */
  recentScreenings(limit: number): StoredScreening[];
  tokenHistory(mint: string): TokenHistory | null;
}
