import {
  evaluateTokenSafety,
  type SafetyReport,
  type SafetyThresholds,
} from "../safety-checks/domain/evaluate-token-safety.js";
import type { HolderDistributionReader } from "../safety-checks/domain/holder-distribution-reader.js";
import type { MintAuthorityReader } from "../safety-checks/domain/mint-authority-reader.js";
import { RateLimitedQueue } from "../shared/rate-limited-queue.js";
import type { NewToken } from "../token-discovery/domain/new-token.js";
import type { NewTokenSource } from "../token-discovery/domain/new-token-source.js";

export type ScreeningResult =
  | { readonly token: NewToken; readonly status: "passed" | "failed"; readonly report: SafetyReport; readonly reason?: never }
  | { readonly token: NewToken; readonly status: "unverified"; readonly reason: string; readonly report?: never };

export interface TokenScreenerOptions {
  readonly source: NewTokenSource;
  readonly authorityReader: MintAuthorityReader;
  readonly distributionReader: HolderDistributionReader;
  readonly thresholds: SafetyThresholds;
  /** Wait before checking, so holders and indexers have time to show up. */
  readonly evaluationDelayMs: number;
  /** Minimum time between checks, to stay under free API rate limits. */
  readonly minIntervalMs: number;
  /** Maximum tokens waiting to be checked; older ones are skipped first. */
  readonly maxPending: number;
  readonly onResult: (result: ScreeningResult) => void;
  readonly onSkip?: (token: NewToken) => void;
}

/** Use case: watch new tokens and run every safety check on each one. */
export class TokenScreener {
  private readonly queue: RateLimitedQueue<NewToken>;
  private readonly delayTimers = new Set<ReturnType<typeof setTimeout>>();
  private running = false;

  constructor(private readonly options: TokenScreenerOptions) {
    this.queue = new RateLimitedQueue<NewToken>({
      minIntervalMs: options.minIntervalMs,
      maxSize: options.maxPending,
      process: (token) => this.screen(token),
      onDrop: (token) => options.onSkip?.(token),
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.options.source.start((token) => this.scheduleEvaluation(token));
  }

  stop(): void {
    this.running = false;
    this.options.source.stop();
    for (const timer of this.delayTimers) clearTimeout(timer);
    this.delayTimers.clear();
    this.queue.clear();
  }

  private scheduleEvaluation(token: NewToken): void {
    const timer = setTimeout(() => {
      this.delayTimers.delete(timer);
      if (this.running) this.queue.enqueue(token);
    }, this.options.evaluationDelayMs);
    this.delayTimers.add(timer);
  }

  private async screen(token: NewToken): Promise<void> {
    const result = await this.evaluate(token);
    if (this.running) this.options.onResult(result);
  }

  private async evaluate(token: NewToken): Promise<ScreeningResult> {
    try {
      const [authorities, distribution] = await Promise.all([
        this.options.authorityReader.read(token.mint),
        this.options.distributionReader.read(token),
      ]);
      if (authorities === null) return { token, status: "unverified", reason: "Mint account not found" };
      if (distribution === null) return { token, status: "unverified", reason: "Holder data not available" };

      const report = evaluateTokenSafety({ authorities, distribution }, this.options.thresholds);
      return { token, status: report.passed ? "passed" : "failed", report };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { token, status: "unverified", reason };
    }
  }
}
