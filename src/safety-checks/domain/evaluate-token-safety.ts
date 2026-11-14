import type { TokenSafetySnapshot } from "./token-safety-snapshot.js";

export type SafetyFailureCode =
  | "MINT_AUTHORITY_ACTIVE"
  | "FREEZE_AUTHORITY_ACTIVE"
  | "DANGEROUS_EXTENSION"
  | "TOP_HOLDERS_CONCENTRATED"
  | "CREATOR_HOLDS_TOO_MUCH"
  | "INSIDER_NETWORK_DETECTED";

export interface SafetyFailure {
  readonly code: SafetyFailureCode;
  readonly detail: string;
}

export interface SafetyThresholds {
  /** Maximum share of supply the top 10 wallets may hold, from 0 to 100. */
  readonly maxTop10Pct: number;
  /** Maximum share of supply the creator may hold, from 0 to 100. */
  readonly maxCreatorPct: number;
  readonly maxInsiderNetworks: number;
}

export const DEFAULT_SAFETY_THRESHOLDS: SafetyThresholds = {
  maxTop10Pct: 30,
  maxCreatorPct: 10,
  maxInsiderNetworks: 0,
};

export interface SafetyReport {
  readonly passed: boolean;
  readonly failures: readonly SafetyFailure[];
  readonly metrics: {
    readonly top10Pct: number;
    readonly creatorPct: number;
    readonly totalHolders: number;
  };
}

const roundPct = (value: number): number => Math.round(value * 100) / 100;

/** Applies every safety rule and reports all failures, not just the first one. */
export const evaluateTokenSafety = (
  snapshot: TokenSafetySnapshot,
  thresholds: SafetyThresholds,
): SafetyReport => {
  const { authorities, distribution } = snapshot;
  const failures: SafetyFailure[] = [];

  const top10Pct = roundPct(
    [...distribution.holders]
      .sort((a, b) => b.pct - a.pct)
      .slice(0, 10)
      .reduce((total, holder) => total + holder.pct, 0),
  );
  const creatorPct = roundPct(distribution.creatorPct);

  if (authorities.mintAuthority !== null) {
    failures.push({
      code: "MINT_AUTHORITY_ACTIVE",
      detail: `Mint authority ${authorities.mintAuthority} can create new tokens`,
    });
  }
  if (authorities.freezeAuthority !== null) {
    failures.push({
      code: "FREEZE_AUTHORITY_ACTIVE",
      detail: `Freeze authority ${authorities.freezeAuthority} can freeze holder accounts`,
    });
  }
  if (authorities.dangerousExtensions.length > 0) {
    failures.push({
      code: "DANGEROUS_EXTENSION",
      detail: `Active extensions: ${authorities.dangerousExtensions.join(", ")}`,
    });
  }
  if (top10Pct > thresholds.maxTop10Pct) {
    failures.push({
      code: "TOP_HOLDERS_CONCENTRATED",
      detail: `Top 10 holders own ${top10Pct}% (max ${thresholds.maxTop10Pct}%)`,
    });
  }
  if (creatorPct > thresholds.maxCreatorPct) {
    failures.push({
      code: "CREATOR_HOLDS_TOO_MUCH",
      detail: `Creator holds ${creatorPct}% (max ${thresholds.maxCreatorPct}%)`,
    });
  }
  if (distribution.insiderNetworks > thresholds.maxInsiderNetworks) {
    failures.push({
      code: "INSIDER_NETWORK_DETECTED",
      detail: `${distribution.insiderNetworks} insider network(s) detected (max ${thresholds.maxInsiderNetworks})`,
    });
  }

  return {
    passed: failures.length === 0,
    failures,
    metrics: { top10Pct, creatorPct, totalHolders: distribution.totalHolders },
  };
};
