import { isObject, readNumber, readObject, readString } from "../../shared/json.js";

/** A keyless public HTTP endpoint that answers with the SOL/USD price. */
export interface SolPriceSource {
  readonly name: string;
  readonly url: string;
  /** Returns the price from the decoded JSON body, or null if it is not there. */
  readonly parse: (body: unknown) => number | null;
}

const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";

const positive = (value: number | null): number | null =>
  value !== null && Number.isFinite(value) && value > 0 ? value : null;

/** Free, keyless sources, tried in this order on every poll. */
export const PUBLIC_SOL_PRICE_SOURCES: readonly SolPriceSource[] = [
  {
    name: "jupiter",
    url: `https://lite-api.jup.ag/price/v3?ids=${WRAPPED_SOL_MINT}`,
    // { "So111...112": { "usdPrice": 75.72, ... } }
    parse: (body) => {
      const entry = isObject(body) ? readObject(body, WRAPPED_SOL_MINT) : null;
      return positive(entry ? readNumber(entry, "usdPrice") : null);
    },
  },
  {
    name: "coingecko",
    url: "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
    // { "solana": { "usd": 75.75 } }
    parse: (body) => {
      const entry = isObject(body) ? readObject(body, "solana") : null;
      return positive(entry ? readNumber(entry, "usd") : null);
    },
  },
  {
    name: "binance",
    url: "https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT",
    // { "symbol": "SOLUSDT", "price": "75.81000000" }
    parse: (body) => {
      const price = isObject(body) ? readString(body, "price") : null;
      return positive(price === null ? null : Number(price));
    },
  },
];
