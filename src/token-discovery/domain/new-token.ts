/** A token that was just created on a launchpad, before any enrichment. */
export interface NewToken {
  readonly mint: string;
  readonly name: string;
  readonly symbol: string;
  readonly creator: string;
  readonly signature: string;
  readonly metadataUri: string;
  readonly bondingCurve: string;
  readonly pool: string;
  /** Tokens bought by the creator in the creation transaction. */
  readonly initialBuyTokens: number;
  /** SOL spent by the creator in the creation transaction. */
  readonly initialBuySol: number;
  readonly marketCapSol: number;
  readonly detectedAt: Date;
}
