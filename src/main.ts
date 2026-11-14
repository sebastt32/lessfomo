import { SqliteHistoryRecorder } from "./history/infrastructure/sqlite/sqlite-history-recorder.js";
import { MomentumTracker, type MomentumSnapshot } from "./momentum/application/momentum-tracker.js";
import { SolanaLogsTradeSource } from "./momentum/infrastructure/solana-logs/solana-logs-trade-source.js";
import { DEFAULT_SAFETY_THRESHOLDS } from "./safety-checks/domain/evaluate-token-safety.js";
import { RugCheckHolderDistributionReader } from "./safety-checks/infrastructure/rugcheck/rugcheck-holder-distribution-reader.js";
import { SolanaRpcMintAuthorityReader } from "./safety-checks/infrastructure/solana-rpc/solana-rpc-mint-authority-reader.js";
import { TokenScreener, type ScreeningResult } from "./screening/token-screener.js";
import type { NewToken } from "./token-discovery/domain/new-token.js";
import type { NewTokenSource } from "./token-discovery/domain/new-token-source.js";
import { PumpPortalNewTokenSource } from "./token-discovery/infrastructure/pumpportal/pumpportal-new-token-source.js";

const readNumberEnv = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const EVALUATION_DELAY_MS = readNumberEnv("EVALUATION_DELAY_MS", 60_000);
const TRACKING_WINDOW_MS = readNumberEnv("TRACKING_WINDOW_MS", 60 * 60_000);
const MOMENTUM_INTERVAL_MS = 60_000;
const TOP_MOVERS = 5;

/** Runs a side effect without letting a storage error take down the live streams. */
const safely = (label: string, action: () => void): void => {
  try {
    action();
  } catch (error) {
    console.error(`[${label}] ${error instanceof Error ? error.message : String(error)}`);
  }
};

const formatScreening = (result: ScreeningResult): string => {
  const { token } = result;
  const label = `${token.symbol.padEnd(12)} ${token.mint}`;
  if (result.status === "unverified") return `?  UNVERIFIED ${label}  (${result.reason})`;

  const { metrics, failures } = result.report;
  const stats = `top10=${metrics.top10Pct}% creator=${metrics.creatorPct}% holders=${metrics.totalHolders}`;
  if (result.status === "passed") return `✓  PASSED     ${label}  ${stats}`;
  return `✗  FAILED     ${label}  ${stats}  [${failures.map((f) => f.code).join(", ")}]`;
};

interface TokenInfo {
  readonly token: NewToken;
  status: ScreeningResult["status"] | "pending";
}

const tokens = new Map<string, TokenInfo>();
const recorder = new SqliteHistoryRecorder(process.env["LESSFOMO_DB_PATH"] || "data/lessfomo.db");
const tracker = new MomentumTracker({ trackingWindowMs: TRACKING_WINDOW_MS });

const formatMover = (snapshot: MomentumSnapshot, rank: number): string => {
  const info = tokens.get(snapshot.mint);
  const { score, components, metrics } = snapshot.momentum;
  const symbol = (info?.token.symbol ?? "?").padEnd(12);
  const status = (info?.status ?? "pending").toUpperCase();
  const priceChange = `${metrics.priceChange5mPct >= 0 ? "+" : ""}${metrics.priceChange5mPct}%`;
  return (
    `  ${rank}. ${symbol} score=${String(score).padStart(3)}  buyers1m=${metrics.uniqueBuyers1m} ` +
    `buyers5m=${metrics.uniqueBuyers5m} accel=${components.acceleration} pressure=${components.buyPressure} ` +
    `Δprice5m=${priceChange}  [${status}] ${snapshot.mint}`
  );
};

/** Feeds every new token to the history and the momentum tracker before screening it. */
const pumpPortal = new PumpPortalNewTokenSource({
  onStatus: (status) => console.log(`[pumpportal] ${status}`),
});
const tokenSource: NewTokenSource = {
  start: (onToken) =>
    pumpPortal.start((token) => {
      tokens.set(token.mint, { token, status: "pending" });
      tracker.track(token, token.detectedAt);
      safely("history", () => recorder.recordToken(token));
      onToken(token);
    }),
  stop: () => pumpPortal.stop(),
};

let skipped = 0;
const screener = new TokenScreener({
  source: tokenSource,
  authorityReader: new SolanaRpcMintAuthorityReader(process.env["SOLANA_RPC_URL"] || undefined),
  distributionReader: new RugCheckHolderDistributionReader(),
  thresholds: DEFAULT_SAFETY_THRESHOLDS,
  evaluationDelayMs: EVALUATION_DELAY_MS,
  minIntervalMs: readNumberEnv("MIN_INTERVAL_MS", 4_000),
  maxPending: readNumberEnv("MAX_PENDING", 50),
  onResult: (result) => {
    const info = tokens.get(result.token.mint);
    if (info !== undefined) info.status = result.status;
    safely("history", () => recorder.recordScreening(result, new Date()));
    console.log(formatScreening(result));
  },
  onSkip: () => {
    skipped += 1;
  },
});

const tradeSource = new SolanaLogsTradeSource({
  ...(process.env["SOLANA_WS_URL"] && { url: process.env["SOLANA_WS_URL"] }),
  onStatus: (status) => console.log(`[solana-logs] ${status}`),
});

const reportMomentum = (): void => {
  const now = new Date();
  const snapshots = tracker.snapshot(now).filter((s) => s.momentum.metrics.tradeCount5m > 0);
  for (const snapshot of snapshots) safely("history", () => recorder.recordMomentum(snapshot));

  for (const [mint, info] of tokens) {
    if (now.getTime() - info.token.detectedAt.getTime() > TRACKING_WINDOW_MS + EVALUATION_DELAY_MS) {
      tokens.delete(mint);
    }
  }

  console.log(
    `[momentum] tracking ${tracker.trackedCount()} token(s), ${tracker.bufferedTradeCount()} trade(s) buffered, ${snapshots.length} active`,
  );
  if (skipped > 0) {
    console.log(`[screener] skipped ${skipped} token(s) in the last minute to respect free rate limits`);
    skipped = 0;
  }
  [...snapshots]
    .sort((a, b) => b.momentum.score - a.momentum.score)
    .slice(0, TOP_MOVERS)
    .forEach((snapshot, index) => console.log(formatMover(snapshot, index + 1)));
};

console.log("lessfomo: screening new pump.fun tokens and tracking momentum...");
screener.start();
tradeSource.start((trade) => {
  if (tracker.record(trade)) safely("history", () => recorder.recordTrade(trade));
});
const momentumTimer = setInterval(reportMomentum, MOMENTUM_INTERVAL_MS);

const shutdown = (): void => {
  clearInterval(momentumTimer);
  tradeSource.stop();
  screener.stop();
  recorder.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
