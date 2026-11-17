import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/app-config.js";
import type { HistoryRecorder } from "../history/domain/history-recorder.js";
import { HISTORY_RECORDER } from "../history/history.module.js";
import type { LiveFeed } from "../live-feed/application/live-feed.js";
import { LIVE_FEED } from "../live-feed/live-feed.module.js";
import { SOL_PRICE_FEED, type SolPriceFeed } from "../market-price/market-price.module.js";
import type { MomentumTracker } from "../momentum/application/momentum-tracker.js";
import type { TradeSource } from "../momentum/domain/trade-source.js";
import { MOMENTUM_TRACKER, TRADE_SOURCE } from "../momentum/momentum.module.js";
import type { SafetyThresholds } from "../safety-checks/domain/evaluate-token-safety.js";
import type { HolderDistributionReader } from "../safety-checks/domain/holder-distribution-reader.js";
import type { MintAuthorityReader } from "../safety-checks/domain/mint-authority-reader.js";
import {
  HOLDER_DISTRIBUTION_READER,
  MINT_AUTHORITY_READER,
  SAFETY_THRESHOLDS,
} from "../safety-checks/safety-checks.module.js";
import { errorMessage } from "../shared/error-message.js";
import type { SnapshotScheduler } from "../snapshots/application/snapshot-scheduler.js";
import { SNAPSHOT_SCHEDULER } from "../snapshots/snapshots.module.js";
import type { NewTokenSource } from "../token-discovery/domain/new-token-source.js";
import { NEW_TOKEN_SOURCE } from "../token-discovery/token-discovery.module.js";
import type { ReputationCloser } from "../wallet-reputation/application/reputation-closer.js";
import type { SmartWalletTracker } from "../wallet-reputation/application/smart-wallet-tracker.js";
import { REPUTATION_CLOSER, SMART_WALLET_TRACKER } from "../wallet-reputation/wallet-reputation.module.js";
import { formatMover, formatScreening } from "./console-report.js";
import { TokenScreener } from "./token-screener.js";

/** Fires a storage write without waiting for it, so a storage error never blocks or takes down the live streams. */
const safely = (label: string, action: () => Promise<void>): void => {
  const report = (error: unknown): void => console.error(`[${label}] ${errorMessage(error)}`);
  try {
    action().catch(report);
  } catch (error) {
    report(error);
  }
};

/**
 * Runs the real-time pipeline: new tokens go to the momentum tracker, the history and the live
 * feed before being screened; trades and a momentum report every minute follow. Started
 * explicitly after the API, and stopped before the API and the history close.
 */
@Injectable()
export class ScreeningPipeline implements OnModuleDestroy {
  private readonly screener: TokenScreener;
  private momentumTimer: ReturnType<typeof setInterval> | null = null;
  private skipped = 0;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LIVE_FEED) private readonly feed: LiveFeed,
    @Inject(HISTORY_RECORDER) private readonly recorder: HistoryRecorder,
    @Inject(MOMENTUM_TRACKER) private readonly tracker: MomentumTracker,
    @Inject(TRADE_SOURCE) private readonly tradeSource: TradeSource,
    @Inject(SOL_PRICE_FEED) private readonly solPrice: SolPriceFeed,
    @Inject(NEW_TOKEN_SOURCE) tokens: NewTokenSource,
    @Inject(MINT_AUTHORITY_READER) authorityReader: MintAuthorityReader,
    @Inject(HOLDER_DISTRIBUTION_READER) distributionReader: HolderDistributionReader,
    @Inject(SAFETY_THRESHOLDS) thresholds: SafetyThresholds,
    @Inject(SNAPSHOT_SCHEDULER) private readonly snapshots: SnapshotScheduler,
    @Inject(SMART_WALLET_TRACKER) private readonly smartWallets: SmartWalletTracker,
    @Inject(REPUTATION_CLOSER) private readonly reputation: ReputationCloser,
  ) {
    /** Feeds every new token to the live feed, the history and the momentum tracker before screening it. */
    const observedTokens: NewTokenSource = {
      start: (onToken) =>
        tokens.start((token) => {
          tracker.track(token, token.detectedAt);
          smartWallets.track(token);
          safely("history", () => recorder.recordToken(token));
          snapshots.tokenDetected(token);
          feed.tokenDetected(token);
          onToken(token);
        }),
      stop: () => tokens.stop(),
    };
    this.screener = new TokenScreener({
      source: observedTokens,
      authorityReader,
      distributionReader,
      thresholds,
      evaluationDelayMs: config.screening.evaluationDelayMs,
      minIntervalMs: config.screening.minIntervalMs,
      maxPending: config.screening.maxPending,
      onResult: (result) => {
        const evaluatedAt = new Date();
        safely("history", () => recorder.recordScreening(result, evaluatedAt));
        feed.screeningFinished(result, evaluatedAt);
        console.log(formatScreening(result));
      },
      onSkip: () => {
        this.skipped += 1;
      },
    });
  }

  start(): void {
    if (this.momentumTimer !== null) return;
    this.screener.start();
    this.solPrice.start();
    this.snapshots.start();
    this.tradeSource.start((trade) => {
      this.snapshots.tradeObserved(trade);
      if (!this.tracker.record(trade)) return;
      safely("history", () => this.recorder.recordTrade(trade));
      // Smart wallets first, so a token's public trade stream includes the buy that makes it public.
      this.smartWallets.tradeRecorded(trade);
      this.feed.tradeRecorded(trade);
    });
    this.reputation.start();
    this.momentumTimer = setInterval(() => this.reportMomentum(), this.config.momentum.reportIntervalMs);
  }

  /** Stops the timer, then the SOL price, trade and token sources, in that order, then the snapshots and the reputation job. */
  async onModuleDestroy(): Promise<void> {
    if (this.momentumTimer === null) return;
    clearInterval(this.momentumTimer);
    this.momentumTimer = null;
    this.solPrice.stop();
    this.tradeSource.stop();
    this.screener.stop();
    await this.snapshots.stop();
    await this.reputation.stop();
  }

  /** Records and publishes momentum of active tokens, then prints the top movers. */
  reportMomentum(): void {
    const { tracker, feed, recorder } = this;
    const { evaluationDelayMs } = this.config.screening;
    const { trackingWindowMs, topMovers } = this.config.momentum;
    const now = new Date();
    const snapshots = tracker.snapshot(now).filter((s) => s.momentum.metrics.tradeCount5m > 0);
    for (const snapshot of snapshots) safely("history", () => recorder.recordMomentum(snapshot));
    feed.prune(now, trackingWindowMs + evaluationDelayMs);
    this.smartWallets.prune(now);
    feed.momentumUpdated(snapshots, now);

    console.log(
      `[momentum] tracking ${tracker.trackedCount()} token(s), ${tracker.bufferedTradeCount()} trade(s) buffered, ${snapshots.length} active`,
    );
    if (this.skipped > 0) {
      console.log(`[screener] skipped ${this.skipped} token(s) in the last minute to respect free rate limits`);
      this.skipped = 0;
    }
    feed.getMovers(topMovers).movers.forEach((mover, index) => console.log(formatMover(mover, index + 1)));
  }
}
