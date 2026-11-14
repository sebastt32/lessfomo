import type { NewToken } from "../../token-discovery/domain/new-token.js";
import type { HolderDistribution } from "./token-safety-snapshot.js";

/** Port: reads who holds a token. Returns null when no holder data is available. */
export interface HolderDistributionReader {
  read(token: NewToken): Promise<HolderDistribution | null>;
}
