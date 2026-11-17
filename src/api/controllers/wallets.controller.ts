import { Controller, Get, Inject, Param } from "@nestjs/common";
import {
  MAX_WALLET_RESULTS,
  type WalletReputationQueries,
} from "../../wallet-reputation/application/wallet-reputation-queries.js";
import { WALLET_REPUTATION_QUERIES } from "../../wallet-reputation/wallet-reputation.module.js";
import { ApiErrors } from "../http/api-error.js";
import { AddressPipe } from "../http/request-params.js";
import { TokenVisibility } from "../token-visibility.js";
import { walletDetailView } from "../views.js";

/** Routes are matched in declaration order: the catch-all must stay last. */
@Controller("api")
export class WalletsController {
  constructor(
    @Inject(WALLET_REPUTATION_QUERIES) private readonly reputation: WalletReputationQueries,
    @Inject(TokenVisibility) private readonly visibility: TokenVisibility,
  ) {}

  @Get("wallets/:address")
  async wallet(@Param("address", AddressPipe) address: string) {
    const detail = await this.reputation.wallet(address, new Date());
    if (detail === null) throw ApiErrors.walletNotFound();
    // The record rates every closed result; only results of public tokens are listed.
    const visible = await this.visibility.publicMints(detail.results.map((result) => result.mint));
    const results = detail.results.filter((result) => visible.has(result.mint)).slice(0, MAX_WALLET_RESULTS);
    return walletDetailView({ ...detail, results });
  }

  /** Anything else under wallets (`/api/wallets/`, `/api/wallets/<address>/other`) is not an address. */
  @Get("wallets/{*rest}")
  notAnAddress(): never {
    throw ApiErrors.invalidAddress();
  }
}
