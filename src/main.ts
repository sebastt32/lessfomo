import { startApiServer, type ApiServer } from "./api/http/api-server.js";
import type { HistoryReader } from "./history/domain/history-reader.js";
import type { HistoryRecorder } from "./history/domain/history-recorder.js";
import { PostgresHistory } from "./history/infrastructure/postgres/postgres-history.js";
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

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Fires a storage write without waiting for it, so a storage error never blocks or takes down the live streams. */
const safely = (label: string, action: () => Promise<void>): void => {
  const report = (error: unknown): void => console.error(`[${label}] ${errorMessage(error)}`);
  try {
    action().catch(report);
  } catch (error) {
    report(error);
  }
};

interface History extends HistoryRecorder, HistoryReader {
  close(): Promise<void>;
}

/** PostgreSQL when DATABASE_URL is set, otherwise a local SQLite file. Never logs the connection string. */
const openHistory = async (): Promise<{ history: History; description: string }> => {
  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl) {
    const history = await PostgresHistory.connect(databaseUrl, {
      onError: (error) => console.error(`[history] ${errorMessage(error)}`),
    });
    return { history, description: "PostgreSQL (DATABASE_URL)" };
  }
  const path = process.env["LESSFOMO_DB_PATH"] || "data/lessfomo.db";
  return { history: new SqliteHistoryRecorder(path), description: `SQLite (${path})` };
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
let opened: Awaited<ReturnType<typeof openHistory>>;
try {
  opened = await openHistory();
} catch (error) {
  console.error(`[history] could not open the history store: ${errorMessage(error)}`);
  process.exit(1);
}
const recorder = opened.history;
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
      onError: (error) => console.error(`[api] ${errorMessage(error)}`),
    });
    console.log(`[api] listening on http://${host}:${port} (CORS: ${corsOrigins.join(", ")})`);
    return api;
  } catch (error) {
    console.error(`[api] could not start: ${errorMessage(error)}`);
    return null;
  }
};

console.log("lessfomo: screening new pump.fun tokens and tracking momentum...");
console.log(`[history] storing in ${opened.description}`);
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
  await recorder.close().catch((error: unknown) => console.error(`[history] ${errorMessage(error)}`));
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
