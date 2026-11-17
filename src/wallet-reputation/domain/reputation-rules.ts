import { median, NO_STATS, round2, roundSol, type ClosedResult, type ReputationStats } from "./closed-result.js";

export type WalletTier = "elite" | "good" | "none";

/** How a wallet usually trades (decision D7): `unrated` when its tier is none. */
export type WalletStyle = "conviction" | "flipper" | "mixed" | "unrated";

export interface StyleRules {
  /** A token first sold this soon (or sooner) after the first buy is a flip. */
  readonly flipWindowMs: number;
  /** 0-100; a good-or-elite wallet flipping at most this share of its tokens has the conviction style. */
  readonly convictionMaxFlipRatePct: number;
  /** 0-100; a good-or-elite wallet flipping at least this share is a flipper. */
  readonly flipperMinFlipRatePct: number;
}

export interface TierThresholds {
  /** Closed tokens in the lookback window. */
  readonly minTokens: number;
  /** 0-100; a win is a closed token with a positive result. */
  readonly minWinRatePct: number;
  /** Good needs a net PnL strictly above this; elite needs at least this. */
  readonly minNetPnlSol: number;
}

export interface ReputationRules {
  /** Only results closed this long before a moment rate a wallet at that moment. */
  readonly lookbackMs: number;
  readonly good: TierThresholds;
  readonly elite: TierThresholds;
  /** Distinct tokens first-bought per active hour, on average, that flag a wallet as a bot. */
  readonly botTokensPerHour: number;
  /** Trading style from the same results as the tier (decision D7). */
  readonly style: StyleRules;
}

const HOUR_MS = 3_600_000;

/** Decision D7: a flip is a first sell within 120 s; conviction flips ≤ 30% of its tokens, a flipper ≥ 60%. */
export const DEFAULT_STYLE_RULES: StyleRules = { flipWindowMs: 120_000, convictionMaxFlipRatePct: 30, flipperMinFlipRatePct: 60 };

/** Decision D1: good = ≥5 tokens, ≥55%, > 0 SOL; elite = ≥10 tokens, ≥65%, ≥ 5 SOL; bot = ≥20 tokens per hour. */
export const DEFAULT_REPUTATION_RULES: ReputationRules = {
  lookbackMs: 7 * 24 * HOUR_MS,
  good: { minTokens: 5, minWinRatePct: 55, minNetPnlSol: 0 },
  elite: { minTokens: 10, minWinRatePct: 65, minNetPnlSol: 5 },
  botTokensPerHour: 20,
  style: DEFAULT_STYLE_RULES,
};

/** Seconds rounded to the millisecond, so a median of two entries carries no float noise. */
const roundMs = (seconds: number | null): number | null => (seconds === null ? null : Math.round(seconds * 1000) / 1000);

const winRatePct = ({ tokens, wins }: ReputationStats): number => (tokens === 0 ? 0 : (wins / tokens) * 100);

export const tierOf = (stats: ReputationStats, rules: ReputationRules): WalletTier => {
  const rate = winRatePct(stats);
  const { good, elite } = rules;
  if (stats.tokens >= elite.minTokens && rate >= elite.minWinRatePct && stats.netPnlSol >= elite.minNetPnlSol) return "elite";
  if (stats.tokens >= good.minTokens && rate >= good.minWinRatePct && stats.netPnlSol > good.minNetPnlSol) return "good";
  return "none";
};

const styleRules = (rules: ReputationRules): StyleRules => rules.style ?? DEFAULT_STYLE_RULES;

const flipRatePct = ({ tokens, flips }: ReputationStats): number => (tokens === 0 ? 0 : (flips / tokens) * 100);

/** Point-in-time style from the same stats as the tier (decision D7). */
export const styleOf = (stats: ReputationStats, rules: ReputationRules): WalletStyle => {
  if (tierOf(stats, rules) === "none") return "unrated";
  const rate = flipRatePct(stats);
  const style = styleRules(rules);
  if (rate <= style.convictionMaxFlipRatePct) return "conviction";
  if (rate >= style.flipperMinFlipRatePct) return "flipper";
  return "mixed";
};

/** Seconds from the first buy to the first sell before the close; null when it never sold. */
export const holdSeconds = ({ firstBuyAt, firstSellAt }: Pick<ClosedResult, "firstBuyAt" | "firstSellAt">): number | null =>
  firstSellAt === null ? null : Math.max(0, firstSellAt.getTime() - firstBuyAt.getTime()) / 1000;

const isFlip = (result: Pick<ClosedResult, "firstBuyAt" | "firstSellAt">, flipWindowMs: number): boolean => {
  const hold = holdSeconds(result);
  return hold !== null && hold * 1000 <= flipWindowMs;
};

/** Results that rate a wallet at `at`: closed strictly before it, within `lookbackMs` before it (no look-ahead). */
export const resultsAt = <T extends Pick<ClosedResult, "closedAt">>(results: readonly T[], at: Date, lookbackMs: number): T[] => {
  const end = at.getTime();
  const start = end - lookbackMs;
  return results.filter(({ closedAt }) => closedAt.getTime() < end && closedAt.getTime() >= start);
};

const statsOf = (
  results: readonly Pick<ClosedResult, "pnlSol" | "firstBuyAt" | "firstSellAt">[],
  flipWindowMs: number,
): ReputationStats =>
  results.reduce<ReputationStats>(
    (stats, result) => ({
      tokens: stats.tokens + 1,
      wins: stats.wins + (result.pnlSol > 0 ? 1 : 0),
      netPnlSol: roundSol(stats.netPnlSol + result.pnlSol),
      flips: stats.flips + (isFlip(result, flipWindowMs) ? 1 : 0),
    }),
    NO_STATS,
  );

/** Point-in-time stats of a wallet at `at` (decisions D2 and D7). */
export const statsAt = (
  results: readonly ClosedResult[],
  at: Date,
  lookbackMs: number,
  flipWindowMs = DEFAULT_STYLE_RULES.flipWindowMs,
): ReputationStats => statsOf(resultsAt(results, at, lookbackMs), flipWindowMs);

/** Distinct tokens first-bought per active clock hour, on average, at least `botTokensPerHour`. */
export const isBot = (results: readonly Pick<ClosedResult, "mint" | "firstBuyAt">[], rules: ReputationRules): boolean => {
  if (results.length === 0) return false;
  const tokens = new Set(results.map(({ mint }) => mint)).size;
  const hours = new Set(results.map(({ firstBuyAt }) => Math.floor(firstBuyAt.getTime() / HOUR_MS))).size;
  return tokens / hours >= rules.botTokensPerHour;
};

/** Current reputation of a wallet, from its results closed in the lookback window before `now`. */
export interface WalletRecord {
  readonly address: string;
  readonly tier: WalletTier;
  readonly isBot: boolean;
  readonly tokens: number;
  readonly wins: number;
  /** 0-100 */
  readonly winRate: number;
  readonly netPnlSol: number;
  readonly avgPnlSol: number;
  readonly medianEntrySeconds: number | null;
  readonly style: WalletStyle;
  /** 0-100, share of closed tokens flipped; null without closed tokens. */
  readonly flipRate: number | null;
  /** Median first buy to first sell; tokens never sold before their close are left out. */
  readonly medianHoldSeconds: number | null;
  readonly lastActiveAt: Date | null;
  readonly updatedAt: Date;
}

export const walletRecord = (
  address: string,
  results: readonly ClosedResult[],
  now: Date,
  rules: ReputationRules,
): WalletRecord => {
  const recent = resultsAt(results, now, rules.lookbackMs);
  const stats = statsOf(recent, styleRules(rules).flipWindowMs);
  const lastActive = recent.reduce<number | null>(
    (latest, { firstBuyAt }) => (latest === null || firstBuyAt.getTime() > latest ? firstBuyAt.getTime() : latest),
    null,
  );
  return {
    address,
    tier: tierOf(stats, rules),
    isBot: isBot(recent, rules),
    tokens: stats.tokens,
    wins: stats.wins,
    winRate: round2(winRatePct(stats)),
    netPnlSol: stats.netPnlSol,
    avgPnlSol: stats.tokens === 0 ? 0 : roundSol(stats.netPnlSol / stats.tokens),
    medianEntrySeconds: roundMs(median(recent.map(({ entrySeconds }) => entrySeconds))),
    style: styleOf(stats, rules),
    flipRate: stats.tokens === 0 ? null : round2(flipRatePct(stats)),
    medianHoldSeconds: roundMs(median(recent.flatMap((result) => holdSeconds(result) ?? []))),
    lastActiveAt: lastActive === null ? null : new Date(lastActive),
    updatedAt: now,
  };
};
