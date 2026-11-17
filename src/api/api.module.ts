import { Module, type MiddlewareConsumer, type NestModule } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { AuthModule } from "../auth/auth.module.js";
import { AuthRequestMiddleware, SessionGuardMiddleware } from "../auth/http/auth.middleware.js";
import { HistoryModule } from "../history/history.module.js";
import { LiveFeedModule } from "../live-feed/live-feed.module.js";
import { MarketPriceModule } from "../market-price/market-price.module.js";
import { errorMessage } from "../shared/error-message.js";
import { WalletReputationModule } from "../wallet-reputation/wallet-reputation.module.js";
import { AnalysisController } from "./controllers/analysis.controller.js";
import { HealthController } from "./controllers/health.controller.js";
import { MoversController } from "./controllers/movers.controller.js";
import { ScreeningsController } from "./controllers/screenings.controller.js";
import { StatsController } from "./controllers/stats.controller.js";
import { StreamController } from "./controllers/stream.controller.js";
import { TokensController } from "./controllers/tokens.controller.js";
import { WalletsController } from "./controllers/wallets.controller.js";
import { API_ERROR_REPORTER, ApiExceptionFilter, type ApiErrorReporter } from "./http/api-exception.filter.js";
import { CorsMiddleware, GetOnlyMiddleware, RequestTargetMiddleware } from "./http/api-middleware.js";
import { LiveStreams } from "./live-streams.js";
import { TokenVisibility } from "./token-visibility.js";

/** The HTTP + SSE API described in docs/API.md: read-only, behind the sign-in of `AuthModule`. */
@Module({
  imports: [LiveFeedModule, HistoryModule, MarketPriceModule, WalletReputationModule, AuthModule],
  controllers: [
    HealthController,
    MoversController,
    ScreeningsController,
    StatsController,
    TokensController,
    WalletsController,
    AnalysisController,
    StreamController,
  ],
  providers: [
    LiveStreams,
    TokenVisibility,
    { provide: API_ERROR_REPORTER, useValue: ((error) => console.error(`[api] ${errorMessage(error)}`)) satisfies ApiErrorReporter },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
export class ApiModule implements NestModule {
  /**
   * In this order, before routing: CORS and preflight, then the session guard (401 for everything
   * but the health check, sign-in and sign-out), then 405, then 400 for an unparsable target, then
   * the CSRF check and JSON body of the auth POSTs.
   * Mounted on "/" (a plain prefix, no route parameters) so Express never tries to percent-decode the
   * path first: with a wildcard parameter, broken encodings skipped these middlewares entirely.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(CorsMiddleware, SessionGuardMiddleware, GetOnlyMiddleware, RequestTargetMiddleware, AuthRequestMiddleware)
      .forRoutes("/");
  }
}
