import type {
  StoredCandle,
  StoredDevTrade,
  StoredMomentumPoint,
  StoredScreening,
  StoredToken,
  TokenHistory,
} from "../history/domain/history-reader.js";
import type {
  HistoryStats,
  TokenListEntry,
  TokenSnapshots,
} from "../history/domain/token-catalog-reader.js";
import type { LiveEvent, LiveTrade, Mover } from "../live-feed/application/live-feed.js";
import type { Liquidity } from "../momentum/domain/liquidity.js";
import { PUMP_TOTAL_SUPPLY, type TokenSnapshot } from "../snapshots/domain/assemble-snapshot.js";
import type { ScreeningResult } from "../screening/token-screener.js";
import type { NewToken } from "../token-discovery/domain/new-token.js";
import type { WalletDetail, SmartWalletAnalysis } from "../wallet-reputation/application/wallet-reputation-queries.js";
import type { WalletRecord } from "../wallet-reputation/domain/reputation-rules.js";
import type {
  SmartWalletInToken,
  SmartWalletsSummary,
  StoredWalletResult,
} from "../wallet-reputation/domain/wallet-reputation-store.js";

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

export const smartWalletsView = (summary: SmartWalletsSummary) => ({
  count: summary.count,
  elite: summary.elite,
  holding: summary.holding,
  conviction: summary.conviction,
});

export const storedScreeningView = (screening: StoredScreening) => ({
  ...screening,
  failureCodes: [...screening.failureCodes],
  evaluatedAt: screening.evaluatedAt.toISOString(),
  detectedAt: screening.detectedAt?.toISOString() ?? null,
  smartWallets: smartWalletsView(screening.smartWallets),
});

export const screeningResultView = (result: ScreeningResult, evaluatedAt: Date, smartWallets: SmartWalletsSummary) => ({
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
  detectedAt: result.token.detectedAt.toISOString(),
  smartWallets: smartWalletsView(smartWallets),
});

export const liquidityView = (liquidity: Liquidity) => ({
  sol: liquidity.sol,
  bondingCurvePct: liquidity.bondingCurvePct,
  migrated: liquidity.migrated,
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
  liquidity: liquidityView(mover.liquidity),
  smartWallets: smartWalletsView(mover.smartWallets),
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
      return { name: "screening", data: screeningResultView(event.result, event.evaluatedAt, event.smartWallets) };
    case "momentum":
      return {
        name: "momentum",
        data: { at: event.at.toISOString(), movers: event.movers.slice(0, STREAM_MOVERS_LIMIT).map(moverView) },
      };
    case "status":
      return { name: "status", data: { sources: event.sources } };
    case "smart-wallet":
      return {
        name: "smart-wallet",
        data: { mint: event.mint, smartWallets: smartWalletsView(event.smartWallets), wallet: smartWalletInTokenView(event.wallet) },
      };
  }
};

/** Unix seconds, as used by chart libraries. */
const unixSeconds = (date: Date): number => Math.floor(date.getTime() / 1000);

export const candleView = (candle: StoredCandle) => ({
  time: unixSeconds(candle.start),
  open: candle.open,
  high: candle.high,
  low: candle.low,
  close: candle.close,
  volumeSol: candle.volumeSol,
  buyVolumeSol: candle.buyVolumeSol,
  sellVolumeSol: candle.sellVolumeSol,
  trades: candle.trades,
});

export const devTradeView = (trade: StoredDevTrade) => ({
  time: unixSeconds(trade.at),
  side: trade.side,
  solAmount: trade.solAmount,
});

export const tradeView = ({ trade, isDev }: LiveTrade) => ({
  signature: trade.signature,
  trader: trade.trader,
  side: trade.side,
  solAmount: trade.solAmount,
  tokenAmount: trade.tokenAmount,
  priceSol: trade.priceSol,
  isDev,
  time: unixSeconds(trade.timestamp),
});

const marketCapSol = (priceSol: number | null): number | null =>
  priceSol === null ? null : Math.round(priceSol * PUMP_TOTAL_SUPPLY * 1e6) / 1e6;

export const tokenListItemView = (entry: TokenListEntry) => ({
  token: tokenView(entry.token),
  status: entry.status,
  lifecycle: entry.lifecycle,
  liquidity: liquidityView(entry.liquidity),
  lastPriceSol: entry.lastPriceSol,
  lastMarketCapSol: marketCapSol(entry.lastPriceSol),
  peakMarketCapSol: marketCapSol(entry.peakPriceSol),
  maxScore: entry.maxScore,
  holders: entry.holders,
  lastTradeAt: entry.lastTradeAt?.toISOString() ?? null,
  snapshotCount: entry.snapshotCount,
  smartWallets: smartWalletsView(entry.smartWallets),
});

export const tokenSnapshotView = (snapshot: TokenSnapshot) => ({
  milestone: snapshot.milestone,
  at: snapshot.at.toISOString(),
  priceSol: snapshot.priceSol,
  marketCapSol: snapshot.marketCapSol,
  volumeSol: snapshot.volumeSol,
  buys: snapshot.buys,
  sells: snapshot.sells,
  uniqueBuyers: snapshot.uniqueBuyers,
  holders: snapshot.holders,
  top10Pct: snapshot.top10Pct,
  devHoldsPct: snapshot.devHoldsPct,
  liquidity: liquidityView(snapshot.liquidity),
  source: snapshot.source,
});

export const tokenSnapshotsView = (mint: string, { lifecycle, snapshots }: TokenSnapshots) => ({
  mint,
  lifecycle,
  snapshots: snapshots.map(tokenSnapshotView),
});

export const statsView = (stats: HistoryStats) => ({
  since: stats.since?.toISOString() ?? null,
  tokens: { ...stats.tokens },
  screenings: { ...stats.screenings },
  trades: stats.trades,
  snapshots: stats.snapshots,
});

export const walletRecordView = (record: WalletRecord) => ({
  address: record.address,
  tier: record.tier,
  isBot: record.isBot,
  tokens: record.tokens,
  wins: record.wins,
  winRate: record.winRate,
  netPnlSol: record.netPnlSol,
  avgPnlSol: record.avgPnlSol,
  medianEntrySeconds: record.medianEntrySeconds,
  style: record.style,
  flipRate: record.flipRate,
  medianHoldSeconds: record.medianHoldSeconds,
  lastActiveAt: record.lastActiveAt?.toISOString() ?? null,
  updatedAt: record.updatedAt.toISOString(),
});

export const smartWalletInTokenView = (wallet: SmartWalletInToken) => ({
  address: wallet.wallet,
  tierAtEntry: wallet.tierAtEntry,
  styleAtEntry: wallet.styleAtEntry,
  record: walletRecordView(wallet.record),
  firstBuyAt: wallet.firstBuyAt.toISOString(),
  entrySeconds: wallet.entrySeconds,
  boughtSol: wallet.boughtSol,
  soldSol: wallet.soldSol,
  stillHolding: wallet.stillHolding,
});

export const walletTokenResultView = (result: StoredWalletResult) => ({
  mint: result.mint,
  symbol: result.symbol,
  name: result.name,
  firstBuyAt: result.firstBuyAt.toISOString(),
  entrySeconds: result.entrySeconds,
  boughtSol: result.boughtSol,
  soldSol: result.soldSol,
  pnlSol: result.pnlSol,
  closedAt: result.closedAt.toISOString(),
});

export const walletDetailView = (detail: WalletDetail) => ({
  record: walletRecordView(detail.record),
  results: detail.results.map(walletTokenResultView),
});

/** Every response echoes `by`; `by=conviction` labels its buckets `convictionWallets` instead of `smartWallets`. */
export const smartWalletAnalysisView = (analysis: SmartWalletAnalysis) => {
  const base = { from: analysis.from.toISOString(), to: analysis.to.toISOString(), by: analysis.by, costRoundTrip: analysis.costRoundTrip };
  if (analysis.by !== "conviction") return { ...base, buckets: analysis.buckets.map((bucket) => ({ ...bucket })) };
  return { ...base, buckets: analysis.buckets.map(({ smartWallets, ...rest }) => ({ convictionWallets: smartWallets, ...rest })) };
};
