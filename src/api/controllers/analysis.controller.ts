import { Controller, Get, Inject } from "@nestjs/common";
import type { AnalysisBy, WalletReputationQueries } from "../../wallet-reputation/application/wallet-reputation-queries.js";
import { WALLET_REPUTATION_QUERIES } from "../../wallet-reputation/wallet-reputation.module.js";
import { ApiErrors } from "../http/api-error.js";
import { SearchParam } from "../http/request-params.js";
import { parseInstant } from "../http/token-list-query.js";
import type { TokenCycleQueries } from "../../token-cycle/application/token-cycle-queries.js";
import { TOKEN_CYCLE_QUERIES } from "../../token-cycle/token-cycle.module.js";
import { cycleAnalysisView, smartWalletAnalysisView } from "../views.js";

/** Default range of the analysis: the 7 days before `to`. */
const DEFAULT_RANGE_MS = 7 * 24 * 3_600_000;

/** `by`: `smartWallets` (the default: every good-or-elite wallet) or `conviction`. */
const parseBy = (raw: string | null): AnalysisBy => {
  if (raw === null || raw === "smartWallets") return "smartWallets";
  if (raw === "conviction") return "conviction";
  throw ApiErrors.invalidQuery("by", "smartWallets or conviction");
};

@Controller("api")
export class AnalysisController {
  constructor(
    @Inject(WALLET_REPUTATION_QUERIES) private readonly reputation: WalletReputationQueries,
    @Inject(TOKEN_CYCLE_QUERIES) private readonly cycles: TokenCycleQueries,
  ) {}

  @Get("analysis/smart-wallets")
  async smartWallets(
    @SearchParam("from") rawFrom: string | null,
    @SearchParam("to") rawTo: string | null,
    @SearchParam("by") rawBy: string | null,
  ) {
    const by = parseBy(rawBy);
    const to = parseInstant("to", rawTo) ?? new Date();
    const from = parseInstant("from", rawFrom) ?? new Date(to.getTime() - DEFAULT_RANGE_MS);
    return smartWalletAnalysisView(await this.reputation.analysis(from, to, by));
  }

  /** Aggregates over the tokens that appeared in the range (default: the 7 days before `to`). */
  @Get("analysis/cycles")
  async tokenCycles(@SearchParam("from") rawFrom: string | null, @SearchParam("to") rawTo: string | null) {
    const to = parseInstant("to", rawTo) ?? new Date();
    const from = parseInstant("from", rawFrom) ?? new Date(to.getTime() - DEFAULT_RANGE_MS);
    return cycleAnalysisView(await this.cycles.analysis(from, to));
  }
}
