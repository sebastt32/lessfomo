export type TradeSide = "buy" | "sell";

/** State of the pump.fun bonding curve right after a trade. */
export interface BondingCurveState {
  /** SOL actually deposited in the curve: the token's liquidity while it trades on the curve. */
  readonly realSolReserves: number;
  /** 0-100 share of the curve's sellable tokens already bought; null when the curve's parameters are unknown. */
  readonly progressPct: number | null;
  /** No sellable tokens left: the token migrates to PumpSwap. */
  readonly complete: boolean;
}

/** One buy or sell of a token on the pump.fun bonding curve. */
export interface Trade {
  readonly signature: string;
  readonly mint: string;
  readonly trader: string;
  readonly side: TradeSide;
  readonly solAmount: number;
  readonly tokenAmount: number;
  /** Price in SOL per token right after the trade, from the curve's virtual reserves. */
  readonly priceSol: number;
  readonly timestamp: Date;
  /** Present when the trade event carried the curve reserves. */
  readonly curve?: BondingCurveState;
}
