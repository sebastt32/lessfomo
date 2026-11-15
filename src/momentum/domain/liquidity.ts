import type { BondingCurveState } from "./trade.js";

/** Liquidity of a token's market. On the pump.fun bonding curve it is the real SOL in the curve. */
export interface Liquidity {
  /** Null until a trade or pool reading is known. */
  readonly sol: number | null;
  /** 0-100 progress of the pump.fun curve; 100 once migrated; null if unknown. */
  readonly bondingCurvePct: number | null;
  /** The token moved to PumpSwap. */
  readonly migrated: boolean;
}

export const UNKNOWN_LIQUIDITY: Liquidity = { sol: null, bondingCurvePct: null, migrated: false };

export const liquidityFromCurve = (curve: BondingCurveState): Liquidity => ({
  sol: curve.realSolReserves,
  bondingCurvePct: curve.progressPct,
  migrated: curve.complete,
});
