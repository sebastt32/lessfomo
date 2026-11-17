import {
  advanceCycle,
  summarizeCycle,
  type CyclePoint,
  type CycleRules,
  type SnapshotPoint,
  type TokenCycle,
  type TradePoint,
} from "../domain/token-cycle.js";
import type { CycleBacklogCursor, CycleToken, StoredCycle, TokenCycleStore } from "../domain/token-cycle-store.js";
import { CycleEventThrottle } from "./cycle-event-throttle.js";
import type { ExtendedTradeStorage } from "./extended-trade-storage.js";

export interface TokenCycleTrackerOptions {
  readonly store: TokenCycleStore;
  /** Thresholds of decision D1. */
  readonly rules: CycleRules;
  /** Public tokens whose trades keep being stored; a token is added when it appears. */
  readonly extended: ExtendedTradeStorage;
  /** Conviction wallets at entry that make a token public (`PUBLIC_MIN_CONVICTION_WALLETS`). */
  readonly publicMinConvictionWallets: number;
  /** A public token keeps trade-by-trade data this long after its creation (`PUBLIC_TRACKING_HOURS`). */
  readonly publicTrackingMs: number;
  /** The momentum window; extended storage only keeps trades stamped after it. */
  readonly trackingWindowMs: number;
  /** First buys of the conviction wallets the live tracker rated in a token, earliest first. */
  readonly convictionFirstBuys: (mint: string) => readonly Date[];
  /** The public visibility rule: only cycles of public tokens are published. */
  readonly isPublic: (mint: string) => Promise<boolean>;
  /** Every stored change of a cycle (to show it with live movers). */
  readonly onCycle?: (mint: string, cycle: TokenCycle) => void;
  /** A `cycle` event to publish: the token appeared, changed phase, or set a new peak. */
  readonly onEvent: (mint: string, cycle: TokenCycle) => void;
  /** Least time between two new-peak events of a token; phase changes are never delayed. */
  readonly eventMinIntervalMs?: number;
  /** Most trades (and snapshots) read per step while folding a cycle. */
  readonly pointsPerBatch?: number;
  /** Most tokens backfilled per tick. */
  readonly backfillBatchSize?: number;
  readonly startDelayMs?: number;
  /** Pause between backfill ticks while there is a backlog, and when there is none. */
  readonly busyIntervalMs?: number;
  readonly idleIntervalMs?: number;
  readonly clock?: () => Date;
  readonly log?: (line: string) => void;
  readonly onError?: (error: unknown) => void;
}

export interface BackfillResult {
  /** Tokens whose cycle was folded in this tick. */
  readonly processed: number;
  /** More public tokens are waiting for their cycle. */
  readonly backlog: boolean;
}

/** `announce`: a token just appeared live; `live`: publish phase changes and new peaks; `silent`: history, no events. */
type SyncMode = "announce" | "live" | "silent";

const PROGRESS_LOG_MS = 10_000;

/** Trades and snapshots in time order; at the same moment a trade comes first. */
const mergePoints = (trades: readonly TradePoint[], snapshots: readonly SnapshotPoint[]): CyclePoint[] =>
  [...trades, ...snapshots].sort((a, b) => a.at.getTime() - b.at.getTime());

/**
 * Use case: stores the cycle of every public token (stable → explosion → peak → crash).
 *
 * A token appears at the first buy that made its conviction wallets reach the public minimum; that
 * moment is stored once. Its cycle is then folded from the stored trades (and, once trades stop,
 * from stored snapshot prices) through a cursor, so every price counts exactly once, nothing later
 * than a price ever influences it, and a restart continues where it stopped. On startup the same
 * path backfills the tokens that are already public, a bounded batch per tick.
 */
export class TokenCycleTracker {
  private readonly clock: () => Date;
  private readonly throttle: CycleEventThrottle<TokenCycle>;
  /** Cycles of the tokens followed trade by trade, so each trade costs no extra read. */
  private readonly cache = new Map<string, StoredCycle>();
  /** Work of each token, one after another. */
  private readonly queues = new Map<string, Promise<void>>();
  /** Tokens with a sync waiting behind the one that is running. */
  private readonly syncWaiting = new Set<string>();
  private readonly appearing = new Set<string>();
  private readonly publishing = new Set<Promise<void>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<unknown> | null = null;
  private stopped = false;
  private started = false;
  private backfillCursor: CycleBacklogCursor | null = null;
  private progress = { processed: 0, loggedAt: 0, inBacklog: false };

  constructor(private readonly options: TokenCycleTrackerOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.throttle = new CycleEventThrottle({
      minIntervalMs: options.eventMinIntervalMs ?? 10_000,
      send: (mint, cycle) => this.publish(mint, cycle),
    });
  }

  /** Follows the recent public tokens again, then backfills missing cycles in the background. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.schedule(this.options.startDelayMs ?? 5_000, async () => {
      await this.restore();
      return this.backfillTick();
    });
  }

  /** Stops the loop and waits for the work in progress, so nothing is written afterwards. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.throttle.stop();
    await this.running?.catch(() => undefined);
    await this.idle();
  }

  /** Resolves once no cycle work is pending. */
  async idle(): Promise<void> {
    while (this.queues.size > 0 || this.publishing.size > 0) {
      await Promise.all([...this.queues.values(), ...this.publishing]);
    }
  }

  /**
   * A token's live conviction-wallet count changed. When it reaches the public minimum the token
   * appears: at the first buy of the wallet that completed the minimum, not at the time it was rated.
   */
  smartWalletChanged(mint: string, convictionWallets: number): void {
    const minimum = this.options.publicMinConvictionWallets;
    if (this.stopped || convictionWallets < minimum || this.options.extended.has(mint) || this.appearing.has(mint)) return;
    const appearedAt = this.options.convictionFirstBuys(mint)[minimum - 1];
    if (appearedAt === undefined) return;
    this.appearing.add(mint);
    void this.enqueue(mint, async () => {
      try {
        const token = await this.options.store.cycleToken(mint);
        if (token !== null) await this.appear(token, appearedAt, true);
      } finally {
        this.appearing.delete(mint);
      }
    });
  }

  /** A trade was stored: the cycle of a followed public token folds it. */
  tradeStored(mint: string): void {
    if (this.options.extended.has(mint)) this.requestSync(mint);
  }

  /** A snapshot was stored: once trades stopped, its price continues the token's cycle. */
  snapshotSaved(mint: string): void {
    this.requestSync(mint);
  }

  /** Forgets the tokens whose extended window ended. */
  prune(now: Date): void {
    for (const mint of this.options.extended.prune(now)) this.cache.delete(mint);
  }

  /** Follows again the public tokens still inside their extended window (after a restart). */
  async restore(): Promise<void> {
    const { store, extended, publicTrackingMs } = this.options;
    const since = new Date(this.clock().getTime() - publicTrackingMs);
    const cycles = await store.recentCycles(since, extended.capacity);
    for (const cycle of cycles) {
      this.follow(cycle, cycle.appearedAt);
      await this.enqueue(cycle.mint, () => this.sync(cycle.mint, "live"));
    }
    const followed = cycles.filter((cycle) => extended.has(cycle.mint)).length;
    if (followed > 0) this.options.log?.(`[cycles] following ${followed} public token(s) trade by trade`);
  }

  /**
   * Gives a cycle to a batch of stored public tokens that have none (or a half-folded one), newest
   * first, without events. Idempotent: finished cycles are never listed again.
   */
  async backfillTick(): Promise<BackfillResult> {
    const { store, publicMinConvictionWallets } = this.options;
    const batchSize = this.options.backfillBatchSize ?? 20;
    const tokens = await store.tokensMissingCycle(publicMinConvictionWallets, this.backfillCursor, batchSize);
    let processed = 0;
    for (const token of tokens) {
      await this.enqueue(token.mint, async () => {
        if (await this.backfill(token)) processed += 1;
      });
      this.backfillCursor = { detectedAt: token.detectedAt, mint: token.mint };
    }
    const backlog = tokens.length === batchSize;
    // The pass is over: the next one starts from the newest token again, for tokens that became public meanwhile.
    if (!backlog) this.backfillCursor = null;
    this.report(processed, backlog, tokens.at(-1));
    return { processed, backlog };
  }

  /** False when the stored smart wallets do not say when the token appeared: it is looked at again on the next pass. */
  private async backfill(token: CycleToken): Promise<boolean> {
    const { store, publicMinConvictionWallets } = this.options;
    const existing = await store.tokenCycle(token.mint);
    const appearedAt = existing?.state.appearedAt ?? (await store.appearanceAt(token.mint, publicMinConvictionWallets));
    if (appearedAt === null) return false;
    await this.appear(token, appearedAt, false);
    return true;
  }

  /** Stores when the token appeared (once), extends its trade storage and folds its cycle. */
  private async appear(token: CycleToken, appearedAt: Date, live: boolean): Promise<void> {
    const { cycle, created } = await this.options.store.createCycle(token.mint, appearedAt, this.clock());
    this.follow(token, cycle.state.appearedAt);
    await this.sync(token.mint, !live ? "silent" : created ? "announce" : "live");
  }

  /** Keeps storing the token's trades until its extended window ends, if it has not ended yet. */
  private follow(token: CycleToken, appearedAt: Date): void {
    const expiresAt = new Date(token.detectedAt.getTime() + this.options.publicTrackingMs);
    if (this.clock().getTime() >= expiresAt.getTime()) return;
    const startsAt = new Date(token.detectedAt.getTime() + this.options.trackingWindowMs);
    const dropped = this.options.extended.extend({ mint: token.mint, creator: token.creator, appearedAt, startsAt, expiresAt });
    for (const mint of dropped) this.cache.delete(mint);
  }

  private requestSync(mint: string): void {
    if (this.stopped || this.syncWaiting.has(mint)) return;
    this.syncWaiting.add(mint);
    void this.enqueue(mint, () => {
      this.syncWaiting.delete(mint);
      return this.sync(mint, "live");
    });
  }

  /** Folds every stored price after the cycle's cursors, a bounded batch at a time, and stores the result. */
  private async sync(mint: string, mode: SyncMode): Promise<void> {
    const { store, rules, extended } = this.options;
    const limit = this.options.pointsPerBatch ?? 2_000;
    const before = this.cache.get(mint) ?? (await store.tokenCycle(mint));
    if (before === null) return;

    let current = before;
    for (;;) {
      const { state } = current;
      const trades = await store.cycleTrades(mint, state.tradeCursor, limit);
      const snapshots = await store.cycleSnapshots(mint, state.snapshotCursorAt, limit);
      const moreTrades = trades.length === limit;
      // With trades still unread, only the snapshots taken before the last one read are in order.
      const horizon = moreTrades ? trades[trades.length - 1]!.at.getTime() : null;
      const usable = horizon === null ? snapshots : snapshots.filter((snapshot) => snapshot.at.getTime() < horizon);
      const more = moreTrades || snapshots.length === limit;
      const next = advanceCycle(state, mergePoints(trades, usable), rules);
      const caughtUp = current.caughtUp || !more;
      if (next !== state || caughtUp !== current.caughtUp) {
        const updatedAt = this.clock();
        await store.saveCycle(mint, next, caughtUp, updatedAt);
        current = { state: next, caughtUp, updatedAt };
      }
      if (!more) break;
      // Lets the API and the live streams run between two batches of a long history.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    if (extended.has(mint)) this.cache.set(mint, current);
    if (current === before) return;
    const cycle = summarizeCycle(current.state, current.updatedAt);
    this.options.onCycle?.(mint, cycle);
    if (mode === "silent") return;
    const phaseChanged = current.state.phase !== before.state.phase;
    const newPeak = current.state.peakAt?.getTime() !== before.state.peakAt?.getTime();
    if (mode === "announce" || phaseChanged) this.throttle.offer(mint, cycle, true);
    else if (newPeak) this.throttle.offer(mint, cycle, false);
  }

  /** Publishes a cycle event unless the visibility rule hides the token. */
  private publish(mint: string, cycle: TokenCycle): void {
    const publishing = this.options
      .isPublic(mint)
      .then((visible) => {
        if (visible && !this.stopped) this.options.onEvent(mint, cycle);
      })
      .catch((error: unknown) => this.options.onError?.(error))
      .finally(() => this.publishing.delete(publishing));
    this.publishing.add(publishing);
  }

  /** Runs `work` after the token's previous work; a failure is reported and never breaks the queue. */
  private enqueue(mint: string, work: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(mint) ?? Promise.resolve();
    const next = previous
      .then(() => (this.stopped ? undefined : work()))
      .catch((error: unknown) => this.options.onError?.(error))
      .finally(() => {
        if (this.queues.get(mint) === next) this.queues.delete(mint);
      });
    this.queues.set(mint, next);
    return next;
  }

  private report(processed: number, backlog: boolean, last: CycleToken | undefined): void {
    const progress = this.progress;
    progress.processed += processed;
    if (backlog) progress.inBacklog = true;
    const now = Date.now();
    const caughtUp = progress.inBacklog && !backlog;
    if (progress.processed === 0 || (!caughtUp && now - progress.loggedAt < PROGRESS_LOG_MS)) return;
    const until = last === undefined ? "" : ` (detected down to ${last.detectedAt.toISOString()})`;
    this.options.log?.(
      `[cycles] backfilled ${progress.processed} token cycle(s)${until}${backlog ? ", backfilling..." : caughtUp ? ", caught up" : ""}`,
    );
    this.progress = { processed: 0, loggedAt: now, inBacklog: backlog };
  }

  private schedule(delayMs: number, work: () => Promise<BackfillResult>): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const run = work().then(
        (result) => (result.backlog ? (this.options.busyIntervalMs ?? 50) : (this.options.idleIntervalMs ?? 30_000)),
        (error: unknown) => {
          this.options.onError?.(error);
          return this.options.idleIntervalMs ?? 30_000;
        },
      );
      this.running = run;
      void run.then((next) => this.schedule(next, () => this.backfillTick()));
    }, delayMs);
  }
}
