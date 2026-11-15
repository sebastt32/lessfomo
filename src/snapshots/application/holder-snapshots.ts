import { roundPct, top10HoldersPct } from "../../safety-checks/domain/evaluate-token-safety.js";
import type { HolderDistributionReader } from "../../safety-checks/domain/holder-distribution-reader.js";
import { RateLimitedQueue } from "../../shared/rate-limited-queue.js";
import type { SnapshotStore } from "../domain/snapshot-store.js";
import type { HolderJob, HolderRequester } from "./snapshot-scheduler.js";

/** Holder counts that get their own `event:holders-N` snapshot. */
export const HOLDER_MILESTONES = [100, 500, 1000] as const;

export interface HolderSnapshotsOptions {
  readonly store: Pick<SnapshotStore, "addSnapshotHolders" | "saveSnapshot">;
  readonly reader: HolderDistributionReader;
  /** Minimum time between two reads, on top of the screener's own RugCheck pace. */
  readonly minIntervalMs: number;
  /** Most reads waiting; the oldest are dropped first. */
  readonly maxPending?: number;
  readonly clock?: () => Date;
  readonly onError?: (error: unknown) => void;
}

/**
 * Adds holders, top 10 share and creator share (RugCheck) to the snapshots of survivors, one read
 * at a time through a `RateLimitedQueue`, and takes an event snapshot when a holder milestone is crossed.
 */
export class HolderSnapshots implements HolderRequester {
  private readonly queue: RateLimitedQueue<HolderJob>;
  private readonly clock: () => Date;
  private pending = 0;
  private waiters: (() => void)[] = [];

  constructor(private readonly options: HolderSnapshotsOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.queue = new RateLimitedQueue<HolderJob>({
      minIntervalMs: options.minIntervalMs,
      maxSize: options.maxPending ?? 20,
      process: (job) => this.process(job).finally(() => this.settle()),
      onDrop: () => this.settle(),
      onError: (_job, error) => options.onError?.(error),
    });
  }

  request(job: HolderJob): void {
    this.pending += 1;
    this.queue.enqueue(job);
  }

  stop(): void {
    this.queue.clear();
    this.pending = 0;
    this.notifyIdle();
  }

  /** Resolves once every requested read has finished or was dropped. */
  idle(): Promise<void> {
    if (this.pending === 0) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private async process({ token, snapshot, holderThreshold }: HolderJob): Promise<void> {
    const distribution = await this.options.reader.read(token);
    if (distribution === null) return;
    const holders = {
      holders: distribution.totalHolders,
      top10Pct: top10HoldersPct(distribution),
      devHoldsPct: roundPct(distribution.creatorPct),
    };
    await this.options.store.addSnapshotHolders(snapshot.mint, snapshot.milestone, snapshot.at, holders);

    const crossed = HOLDER_MILESTONES.filter((count) => count > holderThreshold && holders.holders >= count);
    const at = this.clock();
    for (const count of crossed) {
      await this.options.store.saveSnapshot(
        {
          ...snapshot,
          ...holders,
          milestone: `event:holders-${count}`,
          at,
          volumeSol: null,
          buys: null,
          sells: null,
          uniqueBuyers: null,
          source: snapshot.priceSol === null && snapshot.liquidity.sol === null ? "rugcheck" : "mixed",
        },
        { holderThreshold: count },
      );
    }
  }

  private settle(): void {
    this.pending = Math.max(0, this.pending - 1);
    if (this.pending === 0) this.notifyIdle();
  }

  private notifyIdle(): void {
    for (const resolve of this.waiters.splice(0)) resolve();
  }
}
