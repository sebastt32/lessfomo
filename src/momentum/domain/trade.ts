export type TradeSide = "buy" | "sell";

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
}
