import type { MintAuthorities } from "./token-safety-snapshot.js";

/** Port: reads mint control data. Returns null when the mint does not exist. */
export interface MintAuthorityReader {
  read(mint: string): Promise<MintAuthorities | null>;
}
