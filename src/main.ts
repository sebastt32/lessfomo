import { startApiServer, type ApiServer } from "./api/http/api-server.js";
import { SqliteHistoryRecorder } from "./history/infrastructure/sqlite/sqlite-history-recorder.js";
import { LiveFeed, type Mover } from "./live-feed/application/live-feed.js";
import { MomentumTracker } from "./momentum/application/momentum-tracker.js";
import { SolanaLogsTradeSource } from "./momentum/infrastructure/solana-logs/solana-logs-trade-source.js";
import { DEFAULT_SAFETY_THRESHOLDS } from "./safety-checks/domain/evaluate-token-safety.js";
import { RugCheckHolderDistributionReader } from "./safety-checks/infrastructure/rugcheck/rugcheck-holder-distribution-reader.js";
import { SolanaRpcMintAuthorityReader } from "./safety-checks/infrastructure/solana-rpc/solana-rpc-mint-authority-reader.js";
import { TokenScreener, type ScreeningResult } from "./screening/token-screener.js";
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

const formatMover = ({ token, status, snapshot }: Mover, rank: number): string => {
  const { score, components, metrics } = snapshot.momentum;
  const priceChange = `${metrics.priceChange5mPct >= 0 ? "+" : ""}${metrics.priceChange5mPct}%`;
  return (
    `  ${rank}. ${token.symbol.padEnd(12)} score=${String(score).padStart(3)}  buyers1m=${metrics.uniqueBuyers1m} ` +
    `buyers5m=${metrics.uniqueBuyers5m} accel=${components.acceleration} pressure=${components.buyPressure} ` +
    `Δprice5m=${priceChange}  [${status.toUpperCase()}] ${token.mint}`
  );
};

const startedAt = new Date();
const feed = new LiveFeed();
const recorder = new SqliteHistoryRecorder(process.env["LESSFOMO_DB_PATH"] || "data/lessfomo.db");
const tracker = new MomentumTracker({ trackingWindowMs: TRACKING_WINDOW_MS });

/** Feeds every new token to the live feed, the history and the momentum tracker before screening it. */
const pumpPortal = new PumpPortalNewTokenSource({
  onStatus: (status) => {
    console.log(`[pumpportal] ${status}`);
    feed.sourceStatusFromSocket("pumpportal", status);
  },
});
const tokenSource: NewTokenSource = {
  start: (onToken) =>
    pumpPortal.start((token) => {
      tracker.track(token, token.detectedAt);
      safely("history", () => recorder.recordToken(token));
      feed.tokenDetected(token);
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
    const evaluatedAt = new Date();
    safely("history", () => recorder.recordScreening(result, evaluatedAt));
    feed.screeningFinished(result, evaluatedAt);
    console.log(formatScreening(result));
  },
  onSkip: () => {
    skipped += 1;
  },
});

const tradeSource = new SolanaLogsTradeSource({
  ...(process.env["SOLANA_WS_URL"] && { url: process.env["SOLANA_WS_URL"] }),
  onStatus: (status) => {
    console.log(`[solana-logs] ${status}`);
    feed.sourceStatusFromSocket("solanaLogs", status);
  },
});

const reportMomentum = (): void => {
  const now = new Date();
  const snapshots = tracker.snapshot(now).filter((s) => s.momentum.metrics.tradeCount5m > 0);
  for (const snapshot of snapshots) safely("history", () => recorder.recordMomentum(snapshot));
  feed.prune(now, TRACKING_WINDOW_MS + EVALUATION_DELAY_MS);
  feed.momentumUpdated(snapshots, now);

  console.log(
    `[momentum] tracking ${tracker.trackedCount()} token(s), ${tracker.bufferedTradeCount()} trade(s) buffered, ${snapshots.length} active`,
  );
  if (skipped > 0) {
    console.log(`[screener] skipped ${skipped} token(s) in the last minute to respect free rate limits`);
    skipped = 0;
  }
  feed.getMovers(TOP_MOVERS).movers.forEach((mover, index) => console.log(formatMover(mover, index + 1)));
};

const startApi = async (): Promise<ApiServer | null> => {
  const host = process.env["API_HOST"] || "127.0.0.1";
  const port = readNumberEnv("API_PORT", 3001);
  const corsOrigins = (process.env["CORS_ORIGIN"] || "http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  try {
    const api = await startApiServer({
      host,
      port,
      feed,
      history: recorder,
      corsOrigins,
      startedAt,
      onError: (error) => console.error(`[api] ${error instanceof Error ? error.message : String(error)}`),
    });
    console.log(`[api] listening on http://${host}:${port} (CORS: ${corsOrigins.join(", ")})`);
    return api;
  } catch (error) {
    console.error(`[api] could not start: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
};

console.log("lessfomo: screening new pump.fun tokens and tracking momentum...");
const api = await startApi();
screener.start();
tradeSource.start((trade) => {
  if (tracker.record(trade)) safely("history", () => recorder.recordTrade(trade));
});
const momentumTimer = setInterval(reportMomentum, MOMENTUM_INTERVAL_MS);

const shutdown = async (): Promise<void> => {
  clearInterval(momentumTimer);
  tradeSource.stop();
  screener.stop();
  await api?.close();
  recorder.close();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
