import { Module } from "@nestjs/common";
import type { SolUsdPrice } from "./domain/sol-usd-price.js";
import { SolPricePoller } from "./infrastructure/sol-price-poller.js";

/** A `SolUsdPrice` that keeps itself up to date between `start()` and `stop()`. */
export interface SolPriceFeed extends SolUsdPrice {
  start(): void;
  stop(): void;
}

/** Injection token of the `SolPriceFeed` (free keyless public APIs). */
export const SOL_PRICE_FEED = Symbol("SOL_PRICE_FEED");
/** Injection token of the read-only `SolUsdPrice` port, backed by the same feed. */
export const SOL_USD_PRICE = Symbol("SOL_USD_PRICE");

@Module({
  providers: [
    { provide: SOL_PRICE_FEED, useFactory: (): SolPriceFeed => new SolPricePoller() },
    { provide: SOL_USD_PRICE, useExisting: SOL_PRICE_FEED },
  ],
  exports: [SOL_PRICE_FEED, SOL_USD_PRICE],
})
export class MarketPriceModule {}
