import type { StoredMomentumPoint, StoredScreening, StoredToken, TokenHistory } from "../history/domain/history-reader.js";
import type { LiveEvent, Mover } from "../live-feed/application/live-feed.js";
import type { ScreeningResult } from "../screening/token-screener.js";
import type { NewToken } from "../token-discovery/domain/new-token.js";

/** Maps domain objects to the JSON views documented in docs/API.md. */

export const tokenView = (token: NewToken | StoredToken) => ({
  mint: token.mint,
  symbol: token.symbol,
  name: token.name,
  creator: token.creator,
  metadataUri: token.metadataUri,
  initialBuySol: token.initialBuySol,
  marketCapSol: token.marketCapSol,
  detectedAt: token.detectedAt.toISOString(),
});

export const storedScreeningView = (screening: StoredScreening) => ({
  ...screening,
  failureCodes: [...screening.failureCodes],
  evaluatedAt: screening.evaluatedAt.toISOString(),
});

export const screeningResultView = (result: ScreeningResult, evaluatedAt: Date) => ({
  mint: result.token.mint,
  symbol: result.token.symbol,
  name: result.token.name,
  status: result.status,
  reason: result.reason ?? null,
  failureCodes: result.report ? result.report.failures.map((f) => f.code) : [],
  top10Pct: result.report?.metrics.top10Pct ?? null,
  creatorPct: result.report?.metrics.creatorPct ?? null,
  totalHolders: result.report?.metrics.totalHolders ?? null,
  evaluatedAt: evaluatedAt.toISOString(),
});

export const moverView = (mover: Mover) => ({
  mint: mover.token.mint,
  symbol: mover.token.symbol,
  name: mover.token.name,
  status: mover.status,
  detectedAt: mover.token.detectedAt.toISOString(),
  score: mover.snapshot.momentum.score,
  components: mover.snapshot.momentum.components,
  metrics: mover.snapshot.momentum.metrics,
});

export const momentumPointView = (point: StoredMomentumPoint) => ({
  at: point.at.toISOString(),
  score: point.score,
  components: point.components,
  metrics: point.metrics,
});

export const tokenHistoryView = (history: TokenHistory) => ({
  token: tokenView(history.token),
  status: history.status,
  screenings: history.screenings.map(storedScreeningView),
  momentum: history.momentum.map(momentumPointView),
});

/** Movers pushed on each `momentum` event. */
export const STREAM_MOVERS_LIMIT = 20;

export const liveEventView = (event: LiveEvent): { name: string; data: unknown } => {
  switch (event.type) {
    case "token":
      return { name: "token", data: tokenView(event.token) };
    case "screening":
      return { name: "screening", data: screeningResultView(event.result, event.evaluatedAt) };
    case "momentum":
      return {
        name: "momentum",
        data: { at: event.at.toISOString(), movers: event.movers.slice(0, STREAM_MOVERS_LIMIT).map(moverView) },
      };
    case "status":
      return { name: "status", data: { sources: event.sources } };
  }
};
