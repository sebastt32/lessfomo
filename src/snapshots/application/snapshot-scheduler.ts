import type { Liquidity } from "../../momentum/domain/liquidity.js";
import type { Trade } from "../../momentum/domain/trade.js";
import type { NewToken } from "../../token-discovery/domain/new-token.js";
import {
  snapshotFromKnownState,
  snapshotFromQuote,
  snapshotFromTrades,
  type MarketQuote,
  type TokenSnapshot,
} from "../domain/assemble-snapshot.js";
import type { MarketDataSource } from "../domain/market-data-source.js";
import {
  FIRST_MILESTONE,
  isDead,
  milestoneOffsetMs,
  resolveDueMilestone,
  type DueMilestone,
} from "../domain/milestone-schedule.js";
import type { DueToken, SnapshotStateChange, SnapshotStore } from "../domain/snapshot-store.js";
import { MarketWatch } from "./market-watch.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
/** Holder data (RugCheck) is only fetched for survivors: tokens still active at this age. */
const HOLDERS_FROM_MS = HOUR_MS;
/**
 * The creation trade reaches the log stream a moment after PumpPortal announces the token; the
 * `0m` snapshot waits this long so it can include the curve state of that trade.
 */
const FIRST_SNAPSHOT_SETTLE_MS = 5_000;
/** Tokens on schedule detected within this period are watched again after a restart. */
const RESTORE_WINDOW_MS = 8 * 24 * HOUR_MS;

/** A request for the holders of a token at one of its snapshots. */
export interface HolderJob {
  readonly token: NewToken;
  readonly snapshot: TokenSnapshot;
  /** Highest holder milestone already snapshotted. */
  readonly holderThreshold: number;
}

/** Port: fetches holders in the background, under its own rate limit. */
export interface HolderRequester {
  request(job: HolderJob): void;
  stop(): void;
}

export interface SnapshotSchedulerOptions {
  readonly store: SnapshotStore;
  readonly marketData: MarketDataSource;
  readonly holders: HolderRequester;
  /** Trades are only stored while a token is followed live; later snapshots come from DexScreener. */
  readonly trackingWindowMs: number;
  readonly clock?: () => Date;
  readonly tickIntervalMs?: number;
  /** Most due tokens loaded per tick. */
  readonly dueLimit?: number;
  /** Most tokens quoted from DexScreener per tick (30 per request). */
  readonly quoteLimit?: number;
  /** Most event snapshots per tick. */
  readonly eventLimit?: number;
  readonly onError?: (error: unknown) => void;
}

const latest = (...dates: (Date | null | undefined)[]): Date | null =>
  dates.reduce<Date | null>((best, date) => (date && (best === null || date > best) ? date : best), null);

/**
 * Most recent moment the token may have traded, from DexScreener's rolling windows: a trade in
 * the last 5 minutes counts as now; otherwise the start of the smallest window without trades.
 */
const quoteActivity = (quote: MarketQuote, now: Date): Date | null => {
  const traded = (window: keyof MarketQuote["windows"]) => quote.windows[window].buys + quote.windows[window].sells > 0;
  const before = (ms: number) => new Date(now.getTime() - ms);
  if (traded("m5")) return now;
  if (traded("h1")) return before(5 * MINUTE_MS);
  if (traded("h6")) return before(HOUR_MS);
  if (traded("h24")) return before(6 * HOUR_MS);
  return null;
};

const holderToken = (due: DueToken): NewToken => ({
  mint: due.mint,
  name: "",
  symbol: due.symbol,
  creator: due.creator,
  signature: "",
  metadataUri: "",
  bondingCurve: due.bondingCurve,
  pool: "pump",
  initialBuyTokens: 0,
  initialBuySol: 0,
  marketCapSol: due.creationPriceSol,
  detectedAt: due.detectedAt,
});

/**
 * Use case: stores the state of every token on a logarithmic schedule (see milestone-schedule),
 * plus event snapshots (migration, new peak, holder milestones). The schedule lives in the store,
 * so a restart resumes it; each tick does a bounded amount of work.
 */
export class SnapshotScheduler {
  private readonly watch = new MarketWatch();
  private readonly clock: () => Date;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking: Promise<void> | null = null;
  /** Price of the scheduled snapshots taken in the current tick, so their peaks raise no duplicate event. */
  private readonly scheduledPrices = new Map<string, number>();
  private snapshotListener: ((snapshot: TokenSnapshot) => void) | null = null;

  constructor(private readonly options: SnapshotSchedulerOptions) {
    this.clock = options.clock ?? (() => new Date());
  }

  /** Calls `listener` after every snapshot is stored (scheduled or event). It must not throw. */
  onSnapshotSaved(listener: (snapshot: TokenSnapshot) => void): void {
    this.snapshotListener = listener;
  }

  /** Watches the tokens still on schedule again, then ticks every interval. */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.tick(), this.options.tickIntervalMs ?? 5_000);
    this.restore().catch((error: unknown) => this.options.onError?.(error));
  }

  /** Stops ticking and waits for a tick in progress, so nothing is written afterwards. */
  async stop(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.options.holders.stop();
    await this.ticking;
  }

  async restore(): Promise<void> {
    const since = new Date(this.clock().getTime() - RESTORE_WINDOW_MS);
    for (const token of await this.options.store.watchedTokens(since, 50_000)) {
      this.watch.watch(token.mint, token.detectedAt, token.market);
    }
  }

  tokenDetected(token: NewToken): void {
    this.watch.watch(token.mint, token.detectedAt, { creationPriceSol: token.marketCapSol / 1_000_000_000 });
  }

  /** Every pump.fun trade, whether or not its token is still followed live. */
  tradeObserved(trade: Trade): void {
    this.watch.observe(trade);
  }

  /** Runs one tick; a tick already running is joined instead of starting another. */
  tick(): Promise<void> {
    this.ticking ??= this.runTick()
      .catch((error: unknown) => this.options.onError?.(error))
      .finally(() => {
        this.ticking = null;
      });
    return this.ticking;
  }

  watchedCount(): number {
    return this.watch.size();
  }

  private async runTick(): Promise<void> {
    const { store } = this.options;
    const now = this.clock();
    this.scheduledPrices.clear();
    await this.flushMarkets();

    const live: [DueToken, DueMilestone][] = [];
    const remote: [DueToken, DueMilestone][] = [];
    for (const due of await store.dueTokens(now, this.options.dueLimit ?? 100)) {
      const resolved = resolveDueMilestone(due.detectedAt, due.nextMilestone, now);
      if (resolved === null) continue;
      const settling = now.getTime() - due.detectedAt.getTime() < FIRST_SNAPSHOT_SETTLE_MS;
      if (resolved.milestone === FIRST_MILESTONE && settling) continue;
      this.watch.watch(due.mint, due.detectedAt, { ...due.market, creationPriceSol: due.creationPriceSol });
      const offset = milestoneOffsetMs(resolved.milestone) ?? 0;
      (offset <= this.options.trackingWindowMs ? live : remote).push([due, resolved]);
    }

    for (const [due, resolved] of live) await this.guarded(() => this.takeFromTrades(due, resolved, now));

    const quoted = remote.slice(0, this.options.quoteLimit ?? 60);
    if (quoted.length > 0) {
      const quotes = await this.options.marketData.quotes(quoted.map(([due]) => due.mint));
      for (const [due, resolved] of quoted) {
        await this.guarded(() => this.takeFromQuote(due, resolved, quotes.get(due.mint) ?? null, now));
      }
    }

    await this.takeEvents(now);
    await this.flushMarkets();
    this.watch.prune(now);
  }

  private async guarded(work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  private async flushMarkets(): Promise<void> {
    const updates = this.watch.drainUpdates();
    if (updates.length > 0) await this.options.store.updateMarkets(updates);
  }

  /** Known liquidity: the trade stream's when it has one, else the stored one. */
  private knownLiquidity(due: DueToken): Liquidity {
    const watched = this.watch.get(due.mint)?.liquidity;
    return watched !== undefined && (watched.sol !== null || watched.migrated) ? watched : due.market.liquidity;
  }

  private async takeFromTrades(due: DueToken, resolved: DueMilestone, now: Date): Promise<void> {
    // Only trades of the live window: public tokens keep storing trades after it, and those must not
    // change the snapshots taken from stored trades.
    const liveEnd = new Date(due.detectedAt.getTime() + this.options.trackingWindowMs);
    const until = now.getTime() < liveEnd.getTime() ? now : liveEnd;
    const window = await this.options.store.tradeWindow(due.mint, due.lastSnapshotAt, until);
    const watched = this.watch.get(due.mint);
    const snapshot = snapshotFromTrades({
      mint: due.mint,
      milestone: resolved.milestone,
      at: now,
      window,
      liquidity: this.knownLiquidity(due),
      fallbackPriceSol: watched?.lastPriceSol ?? due.market.lastPriceSol ?? due.creationPriceSol,
    });
    await this.saveScheduled(due, resolved, snapshot);
  }

  private async takeFromQuote(due: DueToken, resolved: DueMilestone, quote: MarketQuote | null, now: Date): Promise<void> {
    const { store } = this.options;
    const watched = this.watch.get(due.mint);
    const activity = quote === null ? null : quoteActivity(quote, now);
    if (isDead(latest(due.market.lastActivityAt, watched?.lastTradeAt, activity), due.detectedAt, now)) {
      await store.markDead(due.mint);
      this.watch.forget(due.mint);
      return;
    }

    const knownLiquidity = this.knownLiquidity(due);
    const snapshot =
      quote === null
        ? snapshotFromKnownState({
            mint: due.mint,
            milestone: resolved.milestone,
            at: now,
            lastPriceSol: watched?.lastPriceSol ?? due.market.lastPriceSol,
            liquidity: knownLiquidity,
          })
        : snapshotFromQuote({
            mint: due.mint,
            milestone: resolved.milestone,
            at: now,
            quote,
            sincePreviousMs: due.lastSnapshotAt === null ? null : now.getTime() - due.lastSnapshotAt.getTime(),
            knownLiquidity,
          });

    if (quote !== null) {
      const poolLiquidity = quote.migrated ? snapshot.liquidity : null;
      await store.updateMarkets([
        {
          mint: due.mint,
          lastPriceSol: quote.priceSol,
          peakPriceSol: quote.priceSol,
          lastTradeAt: null,
          lastActivityAt: activity,
          liquidity: poolLiquidity,
        },
      ]);
      this.watch.quoted(due.mint, quote.priceSol, poolLiquidity);
    }
    await this.saveScheduled(due, resolved, snapshot);
    if (quote?.migrated === true && !knownLiquidity.migrated) {
      await this.save({ ...snapshot, milestone: "event:migrated" }, {});
    }
  }

  private async saveScheduled(due: DueToken, resolved: DueMilestone, snapshot: TokenSnapshot): Promise<void> {
    await this.save(snapshot, {
      next: { milestone: resolved.following, at: resolved.followingAt },
      lastMilestone: resolved.milestone,
    });
    this.watch.scheduled(due.mint, resolved.milestone);
    if (snapshot.priceSol !== null) this.scheduledPrices.set(due.mint, snapshot.priceSol);
    if ((milestoneOffsetMs(resolved.milestone) ?? 0) >= HOLDERS_FROM_MS) {
      this.options.holders.request({ token: holderToken(due), snapshot, holderThreshold: due.market.holderThreshold });
    }
  }

  private async save(snapshot: TokenSnapshot, change: SnapshotStateChange): Promise<void> {
    await this.options.store.saveSnapshot(snapshot, change);
    this.snapshotListener?.(snapshot);
  }

  /** Migration and new-peak events seen in the trade stream (at most one new peak per milestone window). */
  private async takeEvents(now: Date): Promise<void> {
    const limit = this.options.eventLimit ?? 100;
    for (const mint of this.watch.takeMigrations().slice(0, limit)) {
      await this.guarded(() => this.takeEvent(mint, "event:migrated", now));
    }
    for (const mint of this.watch.takeNewPeaks().slice(0, limit)) {
      const watched = this.watch.get(mint);
      const window = watched?.lastMilestone ?? null;
      if (window === null || watched?.peakEventWindow === window) continue;
      const captured = this.scheduledPrices.get(mint);
      if (captured !== undefined && watched?.peakPriceSol != null && captured >= watched.peakPriceSol) continue;
      await this.guarded(() => this.takeEvent(mint, "event:new-peak", now, window));
    }
  }

  private async takeEvent(mint: string, milestone: string, now: Date, peakWindow?: string): Promise<void> {
    const watched = this.watch.get(mint);
    if (watched === null) return;
    const snapshot = snapshotFromKnownState({
      mint,
      milestone,
      at: now,
      lastPriceSol: peakWindow === undefined ? (watched.lastPriceSol ?? watched.peakPriceSol) : watched.peakPriceSol,
      liquidity: watched.liquidity,
    });
    await this.save(snapshot, peakWindow === undefined ? {} : { peakEventWindow: peakWindow });
    if (peakWindow !== undefined) this.watch.peakEventTaken(mint, peakWindow);
  }
}
