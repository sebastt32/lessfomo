import { DEFAULT_SAFETY_THRESHOLDS } from "./safety-checks/domain/evaluate-token-safety.js";
import { RugCheckHolderDistributionReader } from "./safety-checks/infrastructure/rugcheck/rugcheck-holder-distribution-reader.js";
import { SolanaRpcMintAuthorityReader } from "./safety-checks/infrastructure/solana-rpc/solana-rpc-mint-authority-reader.js";
import { TokenScreener, type ScreeningResult } from "./screening/token-screener.js";
import { PumpPortalNewTokenSource } from "./token-discovery/infrastructure/pumpportal/pumpportal-new-token-source.js";

const readNumberEnv = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const formatResult = (result: ScreeningResult): string => {
  const { token } = result;
  const label = `${token.symbol.padEnd(12)} ${token.mint}`;

  if (result.status === "unverified") return `?  UNVERIFIED ${label}  (${result.reason})`;

  const { metrics, failures } = result.report;
  const stats = `top10=${metrics.top10Pct}% creator=${metrics.creatorPct}% holders=${metrics.totalHolders}`;
  if (result.status === "passed") return `✓  PASSED     ${label}  ${stats}`;
  return `✗  FAILED     ${label}  ${stats}  [${failures.map((f) => f.code).join(", ")}]`;
};

let skipped = 0;

const screener = new TokenScreener({
  source: new PumpPortalNewTokenSource({
    onStatus: (status) => console.log(`[pumpportal] ${status}`),
  }),
  authorityReader: new SolanaRpcMintAuthorityReader(process.env["SOLANA_RPC_URL"] || undefined),
  distributionReader: new RugCheckHolderDistributionReader(),
  thresholds: DEFAULT_SAFETY_THRESHOLDS,
  evaluationDelayMs: readNumberEnv("EVALUATION_DELAY_MS", 60_000),
  minIntervalMs: readNumberEnv("MIN_INTERVAL_MS", 4_000),
  maxPending: readNumberEnv("MAX_PENDING", 50),
  onResult: (result) => console.log(formatResult(result)),
  onSkip: () => {
    skipped += 1;
  },
});

const skippedReport = setInterval(() => {
  if (skipped === 0) return;
  console.log(`[screener] skipped ${skipped} token(s) in the last minute to respect free rate limits`);
  skipped = 0;
}, 60_000);

console.log("lessfomo: screening new pump.fun tokens...");
screener.start();

const shutdown = (): void => {
  clearInterval(skippedReport);
  screener.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
