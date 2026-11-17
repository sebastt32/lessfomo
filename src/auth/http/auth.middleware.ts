import { Inject, Injectable, type NestMiddleware } from "@nestjs/common";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ApiErrors } from "../../api/http/api-error.js";
import { API_ERROR_REPORTER, type ApiErrorReporter } from "../../api/http/api-exception.filter.js";
import { isAuthPath, requestPath } from "../../api/http/request-target.js";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import type { AuthService } from "../application/auth-service.js";
import { AUTH_SERVICE } from "../auth.tokens.js";
import { readJsonBody } from "./json-body.js";
import { isAllowedOrigin, isHttpsRequest } from "./request-origin.js";
import { attachSession } from "./request-session.js";
import { buildSessionCookie, parseSessionCookie } from "./session-cookie.js";

type Next = (error?: unknown) => void;

/**
 * The only requests served without a session (docs/API.md "Authentication"): the health check,
 * signing in, and signing out (which answers 204 with or without a session). Paths are compared
 * exactly, after normalization: `/api/health/` or `/api/Health` are not the health check.
 */
const isPublic = (request: IncomingMessage): boolean => {
  const path = requestPath(request);
  if (request.method === "GET") return path === "/api/health";
  if (request.method === "POST") return path === "/api/auth/login" || path === "/api/auth/logout";
  return false;
};

/**
 * Requires a signed-in session for everything else: every route and both SSE streams, unknown
 * routes and invalid input included, because it runs right after CORS (which answers preflights)
 * and before the method check, validation, the public visibility rule and the controllers.
 *
 * Fails closed: without a valid session, or when the session cannot be checked, the answer is
 * 401 UNAUTHENTICATED and the request goes no further.
 */
@Injectable()
export class SessionGuardMiddleware implements NestMiddleware<IncomingMessage, ServerResponse> {
  constructor(
    @Inject(AUTH_SERVICE) private readonly auth: AuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(API_ERROR_REPORTER) private readonly report: ApiErrorReporter,
  ) {}

  async use(request: IncomingMessage, response: ServerResponse, next: Next): Promise<void> {
    if (isPublic(request)) {
      next();
      return;
    }
    const token = parseSessionCookie(request.headers.cookie);
    if (token === null) throw ApiErrors.unauthenticated();
    let session;
    try {
      session = await this.auth.authenticate(token);
    } catch (error) {
      this.report(error);
      throw ApiErrors.unauthenticated();
    }
    if (session === null) throw ApiErrors.unauthenticated();
    attachSession(request, session);
    if (session.refreshed) {
      // Sliding expiry: the browser's copy must live as long as the stored session.
      const secure = this.config.auth.cookieSecure || isHttpsRequest(request.headers);
      response.setHeader("set-cookie", buildSessionCookie(token, { maxAgeSeconds: this.auth.sessionMaxAgeSeconds, secure }));
    }
    next();
  }
}

const isJson = (contentType: string | undefined): boolean =>
  (contentType ?? "").split(";")[0]?.trim().toLowerCase() === "application/json";

/**
 * State-changing requests (POST under `/api/auth/`): CSRF defence, then the JSON body.
 * 403 FORBIDDEN_ORIGIN for a foreign `Origin`; 400 INVALID_BODY unless the content type is
 * `application/json` (a type no cross-site form can send) and the body is a small JSON object.
 */
@Injectable()
export class AuthRequestMiddleware implements NestMiddleware<IncomingMessage, ServerResponse> {
  private readonly origins: readonly string[];

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.origins = config.api.corsOrigins;
  }

  async use(request: IncomingMessage, _response: ServerResponse, next: Next): Promise<void> {
    if (request.method !== "POST" || !isAuthPath(request)) {
      next();
      return;
    }
    if (!isAllowedOrigin(request.headers.origin, request.headers.host, this.origins)) throw ApiErrors.forbiddenOrigin();
    if (!isJson(request.headers["content-type"])) throw ApiErrors.invalidBody("Content-Type: application/json");
    await readJsonBody(request);
    next();
  }
}
