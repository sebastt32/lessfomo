import { Inject, Injectable, Module, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/app-config.js";
import { HISTORY_STORE, HistoryModule } from "../history/history.module.js";
import type { HistoryStore } from "../history/infrastructure/open-history-store.js";
import { errorMessage } from "../shared/error-message.js";
import { AuthService } from "./application/auth-service.js";
import { AUTH_CLOCK, AUTH_SERVICE, SESSION_STORE, USER_STORE } from "./auth.tokens.js";
import { LoginThrottle } from "./domain/login-throttle.js";
import type { SessionStore } from "./domain/session-store.js";
import type { UserStore } from "./domain/user-store.js";
import { AuthController } from "./http/auth.controller.js";

export { AUTH_CLOCK, AUTH_SERVICE, SESSION_STORE, USER_STORE } from "./auth.tokens.js";

const DAY_MS = 24 * 60 * 60_000;
const PURGE_INTERVAL_MS = 60 * 60_000;
/** Most expired sessions deleted per run, so a purge never holds the store for long. */
const PURGE_BATCH = 1000;

/** Deletes expired sessions at startup and then every hour, a bounded number each time. */
@Injectable()
export class SessionPurger implements OnApplicationBootstrap, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;

  constructor(@Inject(AUTH_SERVICE) private readonly auth: AuthService) {}

  onApplicationBootstrap(): void {
    this.purge();
    this.timer = setInterval(() => this.purge(), PURGE_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private purge(): void {
    this.auth.purgeExpired(PURGE_BATCH).catch((error: unknown) => console.error(`[auth] ${errorMessage(error)}`));
  }
}

/**
 * Sign-in for the whole platform (docs/API.md "Authentication"): users and sessions in the history
 * store, the `AuthService` and the `/api/auth/*` endpoints. `ApiModule` applies its guard.
 */
@Module({
  imports: [HistoryModule],
  controllers: [AuthController],
  providers: [
    { provide: USER_STORE, inject: [HISTORY_STORE], useFactory: (store: HistoryStore): UserStore => store.history },
    { provide: SESSION_STORE, inject: [HISTORY_STORE], useFactory: (store: HistoryStore): SessionStore => store.history },
    { provide: AUTH_CLOCK, useValue: (): Date => new Date() },
    {
      provide: AUTH_SERVICE,
      inject: [USER_STORE, SESSION_STORE, AUTH_CLOCK, APP_CONFIG],
      useFactory: (users: UserStore, sessions: SessionStore, clock: () => Date, config: AppConfig): AuthService =>
        new AuthService({ users, sessions, clock, sessionMs: config.auth.sessionDays * DAY_MS, throttle: new LoginThrottle(clock) }),
    },
    SessionPurger,
  ],
  exports: [AUTH_SERVICE, USER_STORE, SESSION_STORE, AUTH_CLOCK],
})
export class AuthModule {}
