import { Module } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/app-config.js";
import { DEFAULT_SAFETY_THRESHOLDS } from "./domain/evaluate-token-safety.js";
import type { HolderDistributionReader } from "./domain/holder-distribution-reader.js";
import type { MintAuthorityReader } from "./domain/mint-authority-reader.js";
import { RugCheckHolderDistributionReader } from "./infrastructure/rugcheck/rugcheck-holder-distribution-reader.js";
import { SolanaRpcMintAuthorityReader } from "./infrastructure/solana-rpc/solana-rpc-mint-authority-reader.js";

/** Injection token of the `MintAuthorityReader` port (Solana RPC). */
export const MINT_AUTHORITY_READER = Symbol("MINT_AUTHORITY_READER");
/** Injection token of the `HolderDistributionReader` port (RugCheck). */
export const HOLDER_DISTRIBUTION_READER = Symbol("HOLDER_DISTRIBUTION_READER");
/** Injection token of the `SafetyThresholds` every token must pass. */
export const SAFETY_THRESHOLDS = Symbol("SAFETY_THRESHOLDS");

@Module({
  providers: [
    {
      provide: MINT_AUTHORITY_READER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): MintAuthorityReader => new SolanaRpcMintAuthorityReader(config.solana.rpcUrl),
    },
    {
      provide: HOLDER_DISTRIBUTION_READER,
      useFactory: (): HolderDistributionReader => new RugCheckHolderDistributionReader(),
    },
    { provide: SAFETY_THRESHOLDS, useValue: DEFAULT_SAFETY_THRESHOLDS },
  ],
  exports: [MINT_AUTHORITY_READER, HOLDER_DISTRIBUTION_READER, SAFETY_THRESHOLDS],
})
export class SafetyChecksModule {}
