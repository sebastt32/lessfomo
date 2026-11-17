import { Inject, Injectable } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/app-config.js";
import { WALLET_REPUTATION_STORE } from "../history/history.module.js";
import type { LiveFeed } from "../live-feed/application/live-feed.js";
import { LIVE_FEED } from "../live-feed/live-feed.module.js";
import type { WalletReputationStore } from "../wallet-reputation/domain/wallet-reputation-store.js";
import { ApiErrors } from "./http/api-error.js";

/**
 * The public API only exposes tokens bought by at least `api.publicMinSmartWallets`
 * (`PUBLIC_MIN_SMART_WALLETS`, default 5) good-or-elite wallets (point-in-time tier at entry):
 * stored counts, or the live count while the token is followed. Internal processes never go
 * through this check and keep using every token.
 */
@Injectable()
export class TokenVisibility {
  private readonly minSmartWallets: number;

  constructor(
    @Inject(LIVE_FEED) private readonly feed: LiveFeed,
    @Inject(WALLET_REPUTATION_STORE) private readonly store: WalletReputationStore,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.minSmartWallets = config.api.publicMinSmartWallets;
  }

  async isPublic(mint: string): Promise<boolean> {
    if (this.feed.smartWalletsOf(mint).count >= this.minSmartWallets) return true;
    return (await this.store.tokenSmartSummary(mint)).count >= this.minSmartWallets;
  }

  /** Answers 404 TOKEN_NOT_FOUND for a token that does not qualify, exactly as if it did not exist. */
  async assertPublic(mint: string): Promise<void> {
    if (!(await this.isPublic(mint))) throw ApiErrors.tokenNotFound();
  }

  async publicMints(mints: readonly string[]): Promise<Set<string>> {
    const unique = [...new Set(mints)];
    if (unique.length === 0) return new Set();
    const stored = await this.store.mintsWithSmartWallets(unique, this.minSmartWallets);
    for (const mint of unique) if (this.feed.smartWalletsOf(mint).count >= this.minSmartWallets) stored.add(mint);
    return stored;
  }
}
