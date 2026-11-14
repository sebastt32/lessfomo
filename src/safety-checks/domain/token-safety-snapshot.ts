/** On-chain control over the mint: who can still print, freeze or seize tokens. */
export interface MintAuthorities {
  readonly mintAuthority: string | null;
  readonly freezeAuthority: string | null;
  /** Token-2022 extensions that still let someone take, lock or tax holder funds. */
  readonly dangerousExtensions: readonly string[];
}

/** A wallet holding the token. Pools, lockers and bonding curves are excluded. */
export interface TokenHolder {
  readonly owner: string;
  /** Share of the total supply, from 0 to 100. */
  readonly pct: number;
  readonly insider: boolean;
}

export interface HolderDistribution {
  readonly holders: readonly TokenHolder[];
  /** Share of the total supply held by the creator, from 0 to 100. */
  readonly creatorPct: number;
  /** Groups of wallets detected as connected insiders. */
  readonly insiderNetworks: number;
  readonly totalHolders: number;
}

export interface TokenSafetySnapshot {
  readonly authorities: MintAuthorities;
  readonly distribution: HolderDistribution;
}
