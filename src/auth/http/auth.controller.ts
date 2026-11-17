import { Controller, Get, Header, HttpCode, Inject, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { ApiErrors } from "../../api/http/api-error.js";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import type { AuthService } from "../application/auth-service.js";
import { AUTH_SERVICE } from "../auth.tokens.js";
import { AuthError } from "../domain/auth-error.js";
import { MIN_PASSWORD_LENGTH } from "../domain/password-policy.js";
import { stringFields } from "./json-body.js";
import { clientIpOf, isHttpsRequest } from "./request-origin.js";
import { sessionOf } from "./request-session.js";
import { buildSessionCookie, clearSessionCookie, parseSessionCookie } from "./session-cookie.js";

/** Refusals keep their documented code and status; the kind of secret that was wrong is never echoed. */
const refusal = (error: unknown, wrongPassword: () => Error): unknown => {
  if (!(error instanceof AuthError)) return error;
  if (error.code === "TOO_MANY_ATTEMPTS") return ApiErrors.tooManyAttempts(error.retryAfterSeconds ?? 1);
  if (error.code === "SERVER_BUSY") return ApiErrors.serverBusy(error.retryAfterSeconds ?? 1);
  if (error.code === "WEAK_PASSWORD") return ApiErrors.weakPassword(MIN_PASSWORD_LENGTH);
  return wrongPassword();
};

/** `/api/auth/*` of docs/API.md "Authentication". Responses are never cached. */
@Controller("api/auth")
export class AuthController {
  constructor(
    @Inject(AUTH_SERVICE) private readonly auth: AuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post("login")
  @HttpCode(200)
  @Header("cache-control", "no-store")
  async login(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { username, password } = stringFields(request, ["username", "password"]);
    const clientIp = clientIpOf(request.headers, request.socket.remoteAddress);
    const result = await this.auth.login(username, password, clientIp).catch((error: unknown) => {
      throw refusal(error, ApiErrors.invalidCredentials);
    });
    response.setHeader(
      "set-cookie",
      buildSessionCookie(result.token, { maxAgeSeconds: result.maxAgeSeconds, secure: this.isSecure(request) }),
    );
    return { user: result.user };
  }

  @Get("me")
  @Header("cache-control", "no-store")
  me(@Req() request: Request) {
    const session = sessionOf(request);
    if (session === null) throw ApiErrors.unauthenticated();
    return { user: session.user };
  }

  /** Public on purpose: signing out twice, or after the session expired, is still 204. */
  @Post("logout")
  @HttpCode(204)
  @Header("cache-control", "no-store")
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response): Promise<void> {
    response.setHeader("set-cookie", clearSessionCookie({ secure: this.isSecure(request) }));
    await this.auth.logout(parseSessionCookie(request.headers.cookie));
  }

  @Post("password")
  @HttpCode(204)
  @Header("cache-control", "no-store")
  async password(@Req() request: Request): Promise<void> {
    const session = sessionOf(request);
    if (session === null) throw ApiErrors.unauthenticated();
    const { currentPassword, newPassword } = stringFields(request, ["currentPassword", "newPassword"]);
    const clientIp = clientIpOf(request.headers, request.socket.remoteAddress);
    await this.auth.changePassword(session, currentPassword, newPassword, clientIp).catch((error: unknown) => {
      throw refusal(error, ApiErrors.invalidCurrentPassword);
    });
  }

  private isSecure(request: Request): boolean {
    return this.config.auth.cookieSecure || isHttpsRequest(request.headers);
  }
}
