import type { Liquidity } from "../../momentum/domain/liquidity.js";

/** pump.fun tokens always have a fixed supply of one billion. */
export const PUMP_TOTAL_SUPPLY = 1_000_000_000;

export type SnapshotSource = "trades" | "dexscreener" | "rugcheck" | "mixed";

/** State of one token at one milestone. Activity fields cover the time since the previous snapshot. */
export interface TokenSnapshot {
  readonly mint: string;
  readonly milestone: string;
  readonly at: Date;
  readonly priceSol: number | null;
  readonly marketCapSol: number | null;
  readonly volumeSol: number | null;
  readonly buys: number | null;
  readonly sells: number | null;
  readonly uniqueBuyers: number | null;
  readonly holders: number | null;
  readonly top10Pct: number | null;
  readonly devHoldsPct: number | null;
  readonly liquidity: Liquidity;
  readonly source: SnapshotSource;
}

/** Aggregate of the stored trades of a token since its previous snapshot. */
export interface TradeWindow {
  /** Price of the latest stored trade up to the snapshot, whenever it happened. */
  readonly lastPriceSol: number | null;
  readonly volumeSol: number;
  readonly buys: number;
  readonly sells: number;
  readonly uniqueBuyers: number;
}

export interface QuoteActivity {
  readonly volumeSol: number;
  readonly buys: number;
  readonly sells: number;
}

/** Market of a token as reported by an aggregator (DexScreener), with SOL-denominated values. */
export interface MarketQuote {
  readonly priceSol: number;
  /** SOL in the pool; null on the bonding curve, where the aggregator reports none. */
  readonly liquiditySol: number | null;
  readonly migrated: boolean;
  /** Rolling windows ending now. */
  readonly windows: Readonly<Record<"m5" | "h1" | "h6" | "h24", QuoteActivity>>;
}

const WINDOW_MS: Readonly<Record<keyof MarketQuote["windows"], number>> = {
  m5: 5 * 60_000,
  h1: 3_600_000,
  h6: 6 * 3_600_000,
  h24: 24 * 3_600_000,
};
/** A rolling window counts as "since the previous snapshot" when its length is this close to the gap. */
const WINDOW_TOLERANCE = 0.1;

const marketCap = (priceSol: number | null): number | null =>
  priceSol === null ? null : Math.round(priceSol * PUMP_TOTAL_SUPPLY * 1e6) / 1e6;

const NO_HOLDERS = { holders: null, top10Pct: null, devHoldsPct: null } as const;

export interface TradesSnapshotInput {
  readonly mint: string;
  readonly milestone: string;
  readonly at: Date;
  readonly window: TradeWindow;
  readonly liquidity: Liquidity;
  /** Price at creation, used until a trade is stored. */
  readonly fallbackPriceSol: number | null;
}

/** Snapshot of a token still followed live, from its own stored trades. */
export const snapshotFromTrades = ({
  mint,
  milestone,
  at,
  window,
  liquidity,
  fallbackPriceSol,
}: TradesSnapshotInput): TokenSnapshot => {
  const priceSol = window.lastPriceSol ?? fallbackPriceSol;
  return {
    mint,
    milestone,
    at,
    priceSol,
    marketCapSol: marketCap(priceSol),
    volumeSol: window.volumeSol,
    buys: window.buys,
    sells: window.sells,
    uniqueBuyers: window.uniqueBuyers,
    ...NO_HOLDERS,
    liquidity,
    source: "trades",
  };
};

export interface QuoteSnapshotInput {
  readonly mint: string;
  readonly milestone: string;
  readonly at: Date;
  readonly quote: MarketQuote;
  /** Time since the previous snapshot; null for the first one. */
  readonly sincePreviousMs: number | null;
  /** Latest liquidity seen in the token's own trades. */
  readonly knownLiquidity: Liquidity;
}

const matchingWindow = (quote: MarketQuote, sincePreviousMs: number | null): QuoteActivity | null => {
  if (sincePreviousMs === null) return null;
  for (const [name, length] of Object.entries(WINDOW_MS) as [keyof MarketQuote["windows"], number][]) {
    if (Math.abs(sincePreviousMs - length) <= length * WINDOW_TOLERANCE) return quote.windows[name];
  }
  return null;
};

/**
 * Snapshot of a token after its live window, from DexScreener. Activity is only filled when a
 * DexScreener rolling window matches the time since the previous snapshot. On the bonding curve,
 * where DexScreener reports no liquidity, the latest liquidity from trades is used ("mixed").
 */
export const snapshotFromQuote = ({
  mint,
  milestone,
  at,
  quote,
  sincePreviousMs,
  knownLiquidity,
}: QuoteSnapshotInput): TokenSnapshot => {
  const activity = matchingWindow(quote, sincePreviousMs);
  const poolLiquidity = quote.migrated && quote.liquiditySol !== null;
  const liquidity: Liquidity = poolLiquidity
    ? { sol: quote.liquiditySol, bondingCurvePct: 100, migrated: true }
    : { ...knownLiquidity, migrated: knownLiquidity.migrated || quote.migrated };
  return {
    mint,
    milestone,
    at,
    priceSol: quote.priceSol,
    marketCapSol: marketCap(quote.priceSol),
    volumeSol: activity?.volumeSol ?? null,
    buys: activity?.buys ?? null,
    sells: activity?.sells ?? null,
    uniqueBuyers: null,
    ...NO_HOLDERS,
    liquidity,
    source: !poolLiquidity && knownLiquidity.sol !== null ? "mixed" : "dexscreener",
  };
};

export interface KnownStateSnapshotInput {
  readonly mint: string;
  readonly milestone: string;
  readonly at: Date;
  readonly lastPriceSol: number | null;
  readonly liquidity: Liquidity;
}

/** Snapshot when no market source answers: the last state seen in trades, activity unknown. */
export const snapshotFromKnownState = ({
  mint,
  milestone,
  at,
  lastPriceSol,
  liquidity,
}: KnownStateSnapshotInput): TokenSnapshot => ({
  mint,
  milestone,
  at,
  priceSol: lastPriceSol,
  marketCapSol: marketCap(lastPriceSol),
  volumeSol: null,
  buys: null,
  sells: null,
  uniqueBuyers: null,
  ...NO_HOLDERS,
  liquidity,
  source: "trades",
});
