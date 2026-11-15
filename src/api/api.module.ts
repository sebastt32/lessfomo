import { Module, type MiddlewareConsumer, type NestModule } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { HistoryModule } from "../history/history.module.js";
import { LiveFeedModule } from "../live-feed/live-feed.module.js";
import { MarketPriceModule } from "../market-price/market-price.module.js";
import { errorMessage } from "../shared/error-message.js";
import { HealthController } from "./controllers/health.controller.js";
import { MoversController } from "./controllers/movers.controller.js";
import { ScreeningsController } from "./controllers/screenings.controller.js";
import { StatsController } from "./controllers/stats.controller.js";
import { StreamController } from "./controllers/stream.controller.js";
import { TokensController } from "./controllers/tokens.controller.js";
import { API_ERROR_REPORTER, ApiExceptionFilter, type ApiErrorReporter } from "./http/api-exception.filter.js";
import { CorsMiddleware, GetOnlyMiddleware, RequestTargetMiddleware } from "./http/api-middleware.js";
import { LiveStreams } from "./live-streams.js";

/** The read-only HTTP + SSE API described in docs/API.md. */
@Module({
  imports: [LiveFeedModule, HistoryModule, MarketPriceModule],
  controllers: [
    HealthController,
    MoversController,
    ScreeningsController,
    StatsController,
    TokensController,
    StreamController,
  ],
  providers: [
    LiveStreams,
    { provide: API_ERROR_REPORTER, useValue: ((error) => console.error(`[api] ${errorMessage(error)}`)) satisfies ApiErrorReporter },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
export class ApiModule implements NestModule {
  /**
   * In this order, before routing: CORS and preflight, then 405, then 400 for an unparsable target.
   * Mounted on "/" (a plain prefix, no route parameters) so Express never tries to percent-decode the
   * path first: with a wildcard parameter, broken encodings skipped these middlewares entirely.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorsMiddleware, GetOnlyMiddleware, RequestTargetMiddleware).forRoutes("/");
  }
}
