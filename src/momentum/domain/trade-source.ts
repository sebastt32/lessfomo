import type { Trade } from "./trade.js";

/** Port: any real-time feed of token trades. */
export interface TradeSource {
  start(onTrade: (trade: Trade) => void): void;
  stop(): void;
}
