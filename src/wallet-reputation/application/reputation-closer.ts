import { NO_STATS, type ClosedResult } from "../domain/closed-result.js";
import { DEFAULT_STYLE_RULES, styleOf, tierOf, walletRecord, type ReputationRules, type WalletRecord } from "../domain/reputation-rules.js";
import { DEFAULT_OUTCOME_RULES, tokenOutcome, type OutcomeRules } from "../domain/smart-wallet-outcome.js";
import { closeTokenResults, isHolding, tradesBefore } from "../domain/wallet-positions.js";
import type { ClosableToken, SmartWalletEntry, WalletReputationStore } from "../domain/wallet-reputation-store.js";

export interface ReputationCloserOptions {
  readonly store: WalletReputationStore;
  readonly rules: ReputationRules;
  readonly outcomeRules?: OutcomeRules;
  /** A token closes when this window, counted from its creation, ends. */
  readonly trackingWindowMs: number;
  /** Extra wait after the window, so its last trades are stored first. */
  readonly closeGraceMs?: number;
  /** Most tokens closed per tick. */
  readonly batchSize?: number;
  /** Most wallet records refreshed per tick. */
  readonly refreshBatch?: number;
  /** Records older than this are refreshed again, so results leaving the lookback window count. */
  readonly staleAfterMs?: number;
  /** Most good-or-elite records loaded on start. */
  readonly maxRecords?: number;
  readonly startDelayMs?: number;
  /** Pause between ticks while there is a backlog, and when there is none. */
  readonly busyIntervalMs?: number;
  readonly idleIntervalMs?: number;
  readonly clock?: () => Date;
  /** Receives every refreshed record (to describe live smart wallets; never to rate them). */
  readonly onRecords?: (records: readonly WalletRecord[]) => void;
  /**
   * After each tick: every result closed up to `completeThrough` is stored (null while there is
   * a backlog), and the tokens closed since the last call. Live buys are rated from here.
   */
  readonly onClosedThrough?: (completeThrough: Date | null, closed: readonly string[]) => Promise<void> | void;
  readonly log?: (line: string) => void;
  readonly onError?: (error: unknown) => void;
}

export interface TickResult {
  readonly closed: number;
  readonly refreshed: number;
  /** More closable tokens are waiting. */
  readonly backlog: boolean;
}

/** Tokens detected this long before the newest closed one are looked at again (late writes). */
const WATERMARK_MARGIN_MS = 60 * 60_000;
const PROGRESS_LOG_MS = 10_000;

/**
 * Use case: when a token's live tracking window ends, fixes every trader's result in it, its
 * smart wallets with exact point-in-time tiers, and its outcome for the analysis; then refreshes
 * the affected wallets' current records. Tokens close oldest first, so the results that rate a buy
 * are always stored before it. On startup the same loop backfills every stored token, a bounded
 * batch per tick; closing is idempotent and resumes after a restart. Tokens closed by an older
 * version are closed again the same way (oldest first), which backfills hold times and styles
 * (decision D7) without touching the trades they come from.
 */
export class ReputationCloser {
  private readonly clock: () => Date;
  private readonly dirty = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<unknown> | null = null;
  private stopped = true;
  private watermark: Date | null = null;
  private progress = { closed: 0, refreshed: 0, loggedAt: 0, inBacklog: false };

  constructor(private readonly options: ReputationCloserOptions) {
    this.clock = options.clock ?? (() => new Date());
  }

  /** Loads the stored smart records, then closes and refreshes in the background. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(this.options.startDelayMs ?? 5_000, async () => {
      await this.loadRecords();
      return this.tick();
    });
  }

  /** Stops the loop and waits for the current tick. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    await this.running?.catch(() => undefined);
  }

  /** Pushes the stored good-or-elite records that are still fresh; older ones are refreshed before they are pushed. */
  async loadRecords(): Promise<void> {
    const freshSince = this.clock().getTime() - this.staleAfterMs();
    const records = (await this.options.store.smartWalletRecords(this.options.maxRecords ?? 200_000)).filter(
      ({ updatedAt }) => updatedAt.getTime() >= freshSince,
    );
    this.options.onRecords?.(records);
    this.options.log?.(`[reputation] loaded ${records.length} good or elite wallet(s)`);
  }

  async tick(): Promise<TickResult> {
    const { store, trackingWindowMs } = this.options;
    const batchSize = this.options.batchSize ?? 25;
    const now = this.clock();
    const upTo = new Date(now.getTime() - trackingWindowMs - (this.options.closeGraceMs ?? 30_000));
    const tokens = await store.closableTokens(this.watermark, upTo, batchSize);
    const closed: string[] = [];
    for (const token of tokens) {
      await this.closeToken(token);
      closed.push(token.mint);
      const mark = new Date(token.detectedAt.getTime() - WATERMARK_MARGIN_MS);
      if (this.watermark === null || mark > this.watermark) this.watermark = mark;
    }
    const backlog = tokens.length === batchSize;
    // Without a backlog every token detected up to `upTo` is closed: results up to its window end are all stored.
    await this.options.onClosedThrough?.(backlog ? null : new Date(upTo.getTime() + trackingWindowMs), closed);

    const refreshBatch = this.options.refreshBatch ?? 1_000;
    const wallets = [...this.dirty].slice(0, refreshBatch);
    if (wallets.length < refreshBatch && !backlog) {
      const stale = await store.staleWallets(new Date(now.getTime() - this.staleAfterMs()), refreshBatch - wallets.length);
      for (const wallet of stale) if (!this.dirty.has(wallet)) wallets.push(wallet);
    }
    await this.refresh(wallets, now);

    this.report(tokens.length, wallets.length, backlog, tokens.at(-1));
    return { closed: tokens.length, refreshed: wallets.length, backlog };
  }

  private staleAfterMs(): number {
    return this.options.staleAfterMs ?? 60 * 60_000;
  }

  private async closeToken(token: ClosableToken): Promise<void> {
    const { store, rules } = this.options;
    const closedAt = new Date(token.detectedAt.getTime() + this.options.trackingWindowMs);
    // Only trades inside the window count, so the close is the same whenever this tick runs.
    const trades = tradesBefore(await store.tokenTrades(token.mint), closedAt);
    const { results, positions } = closeTokenResults(trades, token, closedAt);
    const stats =
      results.length === 0
        ? new Map()
        : await store.statsAtBuys(
            results.map(({ wallet, firstBuyAt }) => ({ wallet, at: firstBuyAt })),
            rules.lookbackMs,
            token.mint,
            (rules.style ?? DEFAULT_STYLE_RULES).flipWindowMs,
          );

    const smartWallets: SmartWalletEntry[] = [];
    const smartFirstBuys: number[] = [];
    const convictionFirstBuys: number[] = [];
    for (const result of results) {
      const position = positions.get(result.wallet)!;
      const walletStats = stats.get(result.wallet) ?? NO_STATS;
      const tier = tierOf(walletStats, rules);
      if (tier === "none") continue;
      const style = styleOf(walletStats, rules);
      smartFirstBuys.push(position.firstBuyIndex);
      if (style === "conviction") convictionFirstBuys.push(position.firstBuyIndex);
      smartWallets.push({
        wallet: result.wallet,
        tierAtEntry: tier,
        styleAtEntry: style,
        firstBuyAt: result.firstBuyAt,
        entrySeconds: result.entrySeconds,
        boughtSol: result.boughtSol,
        soldSol: result.soldSol,
        stillHolding: isHolding(position),
      });
    }
    const screenedAt = convictionFirstBuys.length === 0 ? await store.firstScreeningAt(token.mint) : null;
    const outcomeRules = this.options.outcomeRules ?? DEFAULT_OUTCOME_RULES;
    const outcome = tokenOutcome(trades, smartFirstBuys, screenedAt, outcomeRules);
    const convictionOutcome = tokenOutcome(trades, convictionFirstBuys, screenedAt, outcomeRules);

    await store.saveTokenClose({
      mint: token.mint,
      detectedAt: token.detectedAt,
      closedAt,
      results,
      smartWallets,
      outcome,
      convictionOutcome,
    });
    for (const { wallet } of results) this.dirty.add(wallet);
  }

  private async refresh(wallets: readonly string[], now: Date): Promise<void> {
    if (wallets.length === 0) return;
    const { store, rules } = this.options;
    const byWallet = new Map<string, ClosedResult[]>();
    for (const result of await store.walletResults(wallets, new Date(now.getTime() - rules.lookbackMs))) {
      const list = byWallet.get(result.wallet) ?? [];
      list.push(result);
      byWallet.set(result.wallet, list);
    }
    const records = wallets.map((wallet) => walletRecord(wallet, byWallet.get(wallet) ?? [], now, rules));
    await store.saveWalletRecords(records);
    for (const wallet of wallets) this.dirty.delete(wallet);
    this.options.onRecords?.(records);
  }

  private report(closed: number, refreshed: number, backlog: boolean, last: ClosableToken | undefined): void {
    const progress = this.progress;
    progress.closed += closed;
    progress.refreshed += refreshed;
    if (backlog) progress.inBacklog = true;
    const now = Date.now();
    const caughtUp = progress.inBacklog && !backlog;
    if (progress.closed === 0 || (!caughtUp && now - progress.loggedAt < PROGRESS_LOG_MS)) return;
    const until = last === undefined ? "" : ` (detected up to ${last.detectedAt.toISOString()})`;
    this.options.log?.(
      `[reputation] closed ${progress.closed} token(s), refreshed ${progress.refreshed} wallet record(s)${until}${
        backlog ? ", backfilling..." : caughtUp ? ", caught up" : ""
      }`,
    );
    this.progress = { closed: 0, refreshed: 0, loggedAt: now, inBacklog: backlog };
  }

  private schedule(delayMs: number, work: () => Promise<TickResult>): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const run = work().then(
        (result) => (result.backlog || this.dirty.size > 0 ? this.options.busyIntervalMs ?? 50 : this.options.idleIntervalMs ?? 30_000),
        (error: unknown) => {
          this.options.onError?.(error);
          return this.options.idleIntervalMs ?? 30_000;
        },
      );
      this.running = run;
      void run.then((next) => this.schedule(next, () => this.tick()));
    }, delayMs);
  }
}
