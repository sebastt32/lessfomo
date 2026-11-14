import type { NewToken } from "../../../token-discovery/domain/new-token.js";
import type { HolderDistributionReader } from "../../domain/holder-distribution-reader.js";
import type { HolderDistribution } from "../../domain/token-safety-snapshot.js";
import { parseRugCheckReport } from "./parse-rugcheck-report.js";

export const RUGCHECK_API_URL = "https://api.rugcheck.xyz";

/** Reads holder distribution from RugCheck's free, keyless report endpoint. */
export class RugCheckHolderDistributionReader implements HolderDistributionReader {
  constructor(
    private readonly baseUrl: string = RUGCHECK_API_URL,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async read(token: NewToken): Promise<HolderDistribution | null> {
    const response = await this.fetchFn(`${this.baseUrl}/v1/tokens/${token.mint}/report`);
    if (!response.ok) throw new Error(`RugCheck responded ${response.status}`);
    return parseRugCheckReport(await response.json(), token.bondingCurve);
  }
}
