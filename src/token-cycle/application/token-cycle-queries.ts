import { analyzeCycles, type CycleAnalysis } from "../domain/cycle-analysis.js";
import { summarizeCycle, type TokenCycle } from "../domain/token-cycle.js";
import type { TokenCycleStore } from "../domain/token-cycle-store.js";

export interface CycleAnalysisRange extends CycleAnalysis {
  readonly from: Date;
  readonly to: Date;
}

/** Use case: what the API shows about cycles, read from the stored ones. */
export class TokenCycleQueries {
  constructor(private readonly store: TokenCycleStore) {}

  /** Null when the token has no cycle (it never became public). */
  async tokenCycle(mint: string): Promise<TokenCycle | null> {
    const stored = await this.store.tokenCycle(mint);
    return stored === null ? null : summarizeCycle(stored.state, stored.updatedAt);
  }

  /** Aggregates over the cycles that appeared in [from, to); never per-token data. */
  async analysis(from: Date, to: Date): Promise<CycleAnalysisRange> {
    return { from, to, ...analyzeCycles(await this.store.cycleSamples(from, to)) };
  }
}
