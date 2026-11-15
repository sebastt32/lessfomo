import type { Mover } from "../live-feed/application/live-feed.js";
import type { ScreeningResult } from "./token-screener.js";

/** One console line per safety check result. */
export const formatScreening = (result: ScreeningResult): string => {
  const { token } = result;
  const label = `${token.symbol.padEnd(12)} ${token.mint}`;
  if (result.status === "unverified") return `?  UNVERIFIED ${label}  (${result.reason})`;

  const { metrics, failures } = result.report;
  const stats = `top10=${metrics.top10Pct}% creator=${metrics.creatorPct}% holders=${metrics.totalHolders}`;
  if (result.status === "passed") return `✓  PASSED     ${label}  ${stats}`;
  return `✗  FAILED     ${label}  ${stats}  [${failures.map((f) => f.code).join(", ")}]`;
};

/** One console line per top mover, ranked from 1. */
export const formatMover = ({ token, status, snapshot }: Mover, rank: number): string => {
  const { score, components, metrics } = snapshot.momentum;
  const priceChange = `${metrics.priceChange5mPct >= 0 ? "+" : ""}${metrics.priceChange5mPct}%`;
  return (
    `  ${rank}. ${token.symbol.padEnd(12)} score=${String(score).padStart(3)}  buyers1m=${metrics.uniqueBuyers1m} ` +
    `buyers5m=${metrics.uniqueBuyers5m} accel=${components.acceleration} pressure=${components.buyPressure} ` +
    `Δprice5m=${priceChange}  [${status.toUpperCase()}] ${token.mint}`
  );
};
