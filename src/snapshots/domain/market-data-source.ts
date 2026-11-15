import type { MarketQuote } from "./assemble-snapshot.js";

/** Port: current market of tokens from an aggregator. Mints without data are absent from the result. */
export interface MarketDataSource {
  quotes(mints: readonly string[]): Promise<Map<string, MarketQuote>>;
}
