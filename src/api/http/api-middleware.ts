import { Inject, Injectable, type NestMiddleware } from "@nestjs/common";
import type { IncomingMessage, ServerResponse } from "node:http";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { ApiErrors } from "./api-error.js";
import { hasInvalidRequestTarget, isAuthPath } from "./request-target.js";

type Next = (error?: unknown) => void;

/** Allows only the configured browser origins and answers every preflight with 204. */
@Injectable()
export class CorsMiddleware implements NestMiddleware<IncomingMessage, ServerResponse> {
  private readonly origins: readonly string[];

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.origins = config.api.corsOrigins;
  }

  use(request: IncomingMessage, response: ServerResponse, next: Next): void {
    const origin = request.headers.origin;
    if (origin !== undefined && this.origins.includes(origin)) {
      response.setHeader("access-control-allow-origin", origin);
      // The session cookie travels with cross-origin requests of allowed origins only.
      response.setHeader("access-control-allow-credentials", "true");
      // Lets a cross-origin page read how long to wait after 429 TOO_MANY_ATTEMPTS.
      response.setHeader("access-control-expose-headers", "Retry-After");
      response.setHeader("vary", "Origin");
    }
    if (request.method === "OPTIONS") {
      const headers: Record<string, string> = { "access-control-allow-methods": "GET, OPTIONS", "access-control-max-age": "600" };
      if (isAuthPath(request)) {
        headers["access-control-allow-methods"] = "GET, POST, OPTIONS";
        headers["access-control-allow-headers"] = "Content-Type";
      }
      response.writeHead(204, headers);
      response.end();
      return;
    }
    next();
  }
}

/**
 * The API is read-only: any method but GET (and the OPTIONS preflight) is 405, except POST under
 * `/api/auth/` (sign in, sign out, change password).
 */
@Injectable()
export class GetOnlyMiddleware implements NestMiddleware<IncomingMessage, ServerResponse> {
  use(request: IncomingMessage, _response: ServerResponse, next: Next): void {
    const allowed = request.method === "GET" || (request.method === "POST" && isAuthPath(request));
    if (!allowed) throw ApiErrors.methodNotAllowed();
    next();
  }
}

/** Answers 400 BAD_REQUEST for a request target that is not a valid URL. */
@Injectable()
export class RequestTargetMiddleware implements NestMiddleware<IncomingMessage, ServerResponse> {
  use(request: IncomingMessage, _response: ServerResponse, next: Next): void {
    if (hasInvalidRequestTarget(request)) throw ApiErrors.badRequestTarget();
    next();
  }
}
