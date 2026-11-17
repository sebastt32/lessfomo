import { Inject, Injectable } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/app-config.js";
import { WALLET_REPUTATION_STORE } from "../history/history.module.js";
import type { LiveFeed } from "../live-feed/application/live-feed.js";
import { LIVE_FEED } from "../live-feed/live-feed.module.js";
import type { WalletReputationStore } from "../wallet-reputation/domain/wallet-reputation-store.js";
import { ApiErrors } from "./http/api-error.js";

/**
 * The public API only exposes tokens bought by at least `api.publicMinConvictionWallets`
 * (`PUBLIC_MIN_CONVICTION_WALLETS`, default 3) conviction wallets: good-or-elite wallets whose
 * point-in-time style at entry was conviction (decision D7; flippers and mixed wallets never
 * count). Stored counts, or the live count while the token is followed. Internal processes never
 * go through this check and keep using every token.
 */
@Injectable()
export class TokenVisibility {
  private readonly minConvictionWallets: number;

  constructor(
    @Inject(LIVE_FEED) private readonly feed: LiveFeed,
    @Inject(WALLET_REPUTATION_STORE) private readonly store: WalletReputationStore,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.minConvictionWallets = config.api.publicMinConvictionWallets;
  }

  /** Conviction wallets a token needs to be public. */
  get minimum(): number {
    return this.minConvictionWallets;
  }

  async isPublic(mint: string): Promise<boolean> {
    if (this.feed.smartWalletsOf(mint).conviction >= this.minConvictionWallets) return true;
    return (await this.store.tokenSmartSummary(mint)).conviction >= this.minConvictionWallets;
  }

  /** Answers 404 TOKEN_NOT_FOUND for a token that does not qualify, exactly as if it did not exist. */
  async assertPublic(mint: string): Promise<void> {
    if (!(await this.isPublic(mint))) throw ApiErrors.tokenNotFound();
  }

  async publicMints(mints: readonly string[]): Promise<Set<string>> {
    const unique = [...new Set(mints)];
    if (unique.length === 0) return new Set();
    const stored = await this.store.mintsWithConvictionWallets(unique, this.minConvictionWallets);
    for (const mint of unique) if (this.feed.smartWalletsOf(mint).conviction >= this.minConvictionWallets) stored.add(mint);
    return stored;
  }
}
