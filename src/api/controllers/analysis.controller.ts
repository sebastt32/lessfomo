import { Controller, Get, Inject } from "@nestjs/common";
import type { AnalysisBy, WalletReputationQueries } from "../../wallet-reputation/application/wallet-reputation-queries.js";
import { WALLET_REPUTATION_QUERIES } from "../../wallet-reputation/wallet-reputation.module.js";
import { ApiErrors } from "../http/api-error.js";
import { SearchParam } from "../http/request-params.js";
import { parseInstant } from "../http/token-list-query.js";
import { smartWalletAnalysisView } from "../views.js";

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
  constructor(@Inject(WALLET_REPUTATION_QUERIES) private readonly reputation: WalletReputationQueries) {}

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
}
