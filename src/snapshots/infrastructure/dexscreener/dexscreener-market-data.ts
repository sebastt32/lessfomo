import { isObject, readObject, readString, type JsonObject } from "../../../shared/json.js";
import type { MarketQuote, QuoteActivity } from "../../domain/assemble-snapshot.js";
import type { MarketDataSource } from "../../domain/market-data-source.js";

export const DEXSCREENER_API_URL = "https://api.dexscreener.com";
/** Wrapped SOL: pairs quoted in it have SOL-denominated native prices. */
const WRAPPED_SOL = "So11111111111111111111111111111111111111112";
/** DexScreener's id of the pump.fun bonding curve; every other dex is a migrated pool. */
const BONDING_CURVE_DEX = "pumpfun";
/** Maximum addresses per `/tokens/v1` request. */
const MAX_BATCH = 30;
const WINDOWS = ["m5", "h1", "h6", "h24"] as const;
const REQUEST_TIMEOUT_MS = 10_000;

const positiveNumber = (value: unknown): number | null => {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) && number > 0 ? number : null;
};
const count = (source: JsonObject | null, key: string): number => {
  const value = source?.[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
};
const round9 = (value: number): number => Math.round(value * 1e9) / 1e9;

interface Candidate {
  readonly quote: MarketQuote;
  readonly liquidityUsd: number;
}

const parsePair = (pair: unknown, mints: ReadonlySet<string>): [string, Candidate] | null => {
  if (!isObject(pair)) return null;
  const base = readObject(pair, "baseToken");
  const quoteToken = readObject(pair, "quoteToken");
  const mint = base && readString(base, "address");
  if (mint === null || !mints.has(mint) || (quoteToken && readString(quoteToken, "address")) !== WRAPPED_SOL) return null;

  const priceSol = positiveNumber(pair["priceNative"]);
  const priceUsd = positiveNumber(pair["priceUsd"]);
  if (priceSol === null || priceUsd === null) return null;
  const solPerUsd = priceSol / priceUsd;

  const volume = readObject(pair, "volume");
  const txns = readObject(pair, "txns");
  const windows = Object.fromEntries(
    WINDOWS.map((window): [string, QuoteActivity] => {
      const trades = txns && readObject(txns, window);
      return [
        window,
        { volumeSol: round9(count(volume, window) * solPerUsd), buys: count(trades, "buys"), sells: count(trades, "sells") },
      ];
    }),
  ) as MarketQuote["windows"];

  const migrated = readString(pair, "dexId") !== BONDING_CURVE_DEX;
  const liquidity = readObject(pair, "liquidity");
  const liquiditySol = migrated ? positiveNumber(liquidity?.["quote"]) : null;
  return [mint, { quote: { priceSol, liquiditySol, migrated, windows }, liquidityUsd: count(liquidity, "usd") }];
};

const isBetter = (candidate: Candidate, current: Candidate | undefined): boolean => {
  if (current === undefined) return true;
  if (candidate.quote.migrated !== current.quote.migrated) return candidate.quote.migrated;
  return candidate.liquidityUsd > current.liquidityUsd;
};

/**
 * Converts a `/tokens/v1/solana/{mints}` response (an array of pairs) into one quote per mint.
 * Only SOL-quoted pairs count; a migrated pool with the most liquidity wins over the curve.
 */
export const parseDexScreenerTokens = (payload: unknown, mints: readonly string[]): Map<string, MarketQuote> => {
  const best = new Map<string, Candidate>();
  if (!Array.isArray(payload)) return new Map();
  const wanted = new Set(mints);
  for (const pair of payload) {
    const parsed = parsePair(pair, wanted);
    if (parsed !== null && isBetter(parsed[1], best.get(parsed[0]))) best.set(parsed[0], parsed[1]);
  }
  return new Map([...best].map(([mint, candidate]) => [mint, candidate.quote]));
};

export interface DexScreenerMarketDataOptions {
  readonly baseUrl?: string;
  /** Minimum time between the start of two requests (the endpoint allows 300 per minute). */
  readonly minIntervalMs?: number;
  readonly fetchFn?: typeof fetch;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onError?: (error: unknown) => void;
}

/** Reads token markets from DexScreener's free, keyless batch endpoint, one request at a time. */
export class DexScreenerMarketData implements MarketDataSource {
  private lastRequestAt: number | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: DexScreenerMarketDataOptions = {}) {}

  /** Requests are serialized across callers so the minimum interval always holds. */
  quotes(mints: readonly string[]): Promise<Map<string, MarketQuote>> {
    const run = this.queue.then(() => this.fetchAll(mints));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async fetchAll(mints: readonly string[]): Promise<Map<string, MarketQuote>> {
    const quotes = new Map<string, MarketQuote>();
    for (let start = 0; start < mints.length; start += MAX_BATCH) {
      const batch = mints.slice(start, start + MAX_BATCH);
      try {
        for (const [mint, quote] of await this.fetchBatch(batch)) quotes.set(mint, quote);
      } catch (error) {
        this.options.onError?.(error);
      }
    }
    return quotes;
  }

  private async fetchBatch(mints: readonly string[]): Promise<Map<string, MarketQuote>> {
    const now = this.options.now ?? Date.now;
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const minIntervalMs = this.options.minIntervalMs ?? 1_000;
    if (this.lastRequestAt !== null) {
      const wait = minIntervalMs - (now() - this.lastRequestAt);
      if (wait > 0) await sleep(wait);
    }
    this.lastRequestAt = now();

    const fetchFn = this.options.fetchFn ?? fetch;
    const url = `${this.options.baseUrl ?? DEXSCREENER_API_URL}/tokens/v1/solana/${mints.join(",")}`;
    const response = await fetchFn(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`DexScreener responded ${response.status}`);
    return parseDexScreenerTokens(await response.json(), mints);
  }
}
