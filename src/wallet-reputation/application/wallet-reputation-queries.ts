import type { ClosedResult } from "../domain/closed-result.js";
import { walletRecord, type ReputationRules, type WalletRecord } from "../domain/reputation-rules.js";
import { analyzeSmartWalletOutcomes, DEFAULT_OUTCOME_RULES, type AnalysisBucket } from "../domain/smart-wallet-outcome.js";
import type { SmartWalletInToken, StoredWalletResult, WalletReputationStore } from "../domain/wallet-reputation-store.js";

/** Results listed with a wallet's record. */
export const MAX_WALLET_RESULTS = 200;

export interface WalletDetail {
  readonly record: WalletRecord;
  /** Newest first, last 7 days, every one (the API lists at most `MAX_WALLET_RESULTS` of them). */
  readonly results: readonly StoredWalletResult[];
}

/** What the analysis buckets tokens by: every good-or-elite wallet, or only conviction ones (decision D7). */
export type AnalysisBy = "smartWallets" | "conviction";

export interface SmartWalletAnalysis {
  readonly by: AnalysisBy;
  readonly from: Date;
  readonly to: Date;
  readonly costRoundTrip: number;
  readonly buckets: readonly AnalysisBucket[];
}

const TIER_ORDER = { elite: 0, good: 1 } as const;

/** Use case: what the API shows about wallets, computed from stored results with the same rules as the closer. */
export class WalletReputationQueries {
  constructor(
    private readonly store: WalletReputationStore,
    private readonly rules: ReputationRules,
  ) {}

  /** Null when the wallet has no closed result at all. */
  async wallet(address: string, now: Date): Promise<WalletDetail | null> {
    if (!(await this.store.hasWalletResults(address))) return null;
    const results = await this.store.walletResults([address], new Date(now.getTime() - this.rules.lookbackMs));
    return { record: walletRecord(address, results, now, this.rules), results };
  }

  /** Smart wallets of a token, elite first, then earliest entry first, each with its current record. */
  async tokenSmartWallets(mint: string, now: Date): Promise<SmartWalletInToken[]> {
    const entries = await this.store.tokenSmartWallets(mint);
    if (entries.length === 0) return [];
    const byWallet = new Map<string, ClosedResult[]>();
    const since = new Date(now.getTime() - this.rules.lookbackMs);
    for (const result of await this.store.walletResults(entries.map((entry) => entry.wallet), since)) {
      byWallet.set(result.wallet, [...(byWallet.get(result.wallet) ?? []), result]);
    }
    return entries
      .map((entry) => ({ ...entry, record: walletRecord(entry.wallet, byWallet.get(entry.wallet) ?? [], now, this.rules) }))
      .sort(
        (a, b) =>
          TIER_ORDER[a.tierAtEntry] - TIER_ORDER[b.tierAtEntry] ||
          a.entrySeconds - b.entrySeconds ||
          (a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0),
      );
  }

  /**
   * Success per number of smart wallets (or conviction wallets, entered after the k-th conviction
   * wallet's first buy), over closed tokens detected in [from, to).
   */
  async analysis(from: Date, to: Date, by: AnalysisBy = "smartWallets"): Promise<SmartWalletAnalysis> {
    const samples = by === "conviction" ? await this.store.convictionOutcomes(from, to) : await this.store.smartWalletOutcomes(from, to);
    return {
      by,
      from,
      to,
      costRoundTrip: DEFAULT_OUTCOME_RULES.costRoundTrip,
      buckets: analyzeSmartWalletOutcomes(samples, DEFAULT_OUTCOME_RULES.maxBucket),
    };
  }
}
