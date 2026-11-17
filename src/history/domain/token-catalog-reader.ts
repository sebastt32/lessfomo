import type { Liquidity } from "../../momentum/domain/liquidity.js";
import type { TokenSnapshot } from "../../snapshots/domain/assemble-snapshot.js";
import type { SmartWalletsSummary } from "../../wallet-reputation/domain/wallet-reputation-store.js";
import type { CyclePhase, TokenCycle } from "../../token-cycle/domain/token-cycle.js";
import type { StoredToken, TokenHistory } from "./history-reader.js";

export type SafetyStatus = TokenHistory["status"];
export type Lifecycle = "active" | "dead";
export type TokenSortField =
  | "detectedAt"
  | "maxScore"
  | "peakMarketCapSol"
  | "liquidity"
  | "smartWallets"
  | "convictionWallets"
  | "appearedAt"
  | "investWindow";

export interface TokenListQuery {
  /** Inclusive. */
  readonly from: Date | null;
  /** Exclusive. */
  readonly to: Date | null;
  /** Empty means every status. */
  readonly statuses: readonly SafetyStatus[];
  readonly lifecycle: Lifecycle | null;
  readonly minScore: number | null;
  /** Only tokens bought by at least this many good-or-elite wallets (point-in-time tiers); 0 keeps every token. */
  readonly minSmartWallets: number;
  /** Only tokens with at least this many conviction wallets at entry (decision D7); 0 or absent keeps every token. */
  readonly minConvictionWallets?: number;
  /** Only tokens whose cycle is in one of these phases; empty or absent keeps every token. */
  readonly phases?: readonly CyclePhase[];
  /** Only tokens that appeared late (true) or in time (false); null or absent keeps every token. */
  readonly appearedLate?: boolean | null;
  /** Case-insensitive match on symbol or name, or mint prefix. */
  readonly search: string | null;
  readonly sort: { readonly field: TokenSortField; readonly direction: "asc" | "desc" };
  /** 1-based. */
  readonly page: number;
  readonly pageSize: number;
  /** Reference time for the lifecycle. */
  readonly now: Date;
}

export interface TokenListEntry {
  readonly token: StoredToken;
  readonly status: SafetyStatus;
  readonly lifecycle: Lifecycle;
  readonly liquidity: Liquidity;
  readonly lastPriceSol: number | null;
  readonly peakPriceSol: number | null;
  readonly maxScore: number | null;
  readonly holders: number | null;
  readonly lastTradeAt: Date | null;
  readonly snapshotCount: number;
  readonly smartWallets: SmartWalletsSummary;
  /** Absent when the token has no cycle (it never became public). */
  readonly cycle?: TokenCycle;
}

export interface TokenList {
  readonly tokens: readonly TokenListEntry[];
  readonly total: number;
}

export interface TokenSnapshots {
  readonly lifecycle: Lifecycle;
  /** Oldest first. */
  readonly snapshots: readonly TokenSnapshot[];
}

export interface HistoryStats {
  /** First token ever stored; null while there is none. */
  readonly since: Date | null;
  readonly tokens: { readonly total: number; readonly active: number; readonly dead: number; readonly migrated: number };
  readonly screenings: Readonly<Record<SafetyStatus, number>>;
  readonly trades: number;
  readonly snapshots: number;
}

/** Port: every token ever detected, with its latest state and snapshots. */
export interface TokenCatalogReader {
  listTokens(query: TokenListQuery): Promise<TokenList>;
  /** Null if the token was never seen. */
  tokenSnapshots(mint: string, now: Date): Promise<TokenSnapshots | null>;
  stats(now: Date): Promise<HistoryStats>;
}
