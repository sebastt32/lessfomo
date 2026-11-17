import { AuthError } from "../domain/auth-error.js";
import type { LoginThrottle } from "../domain/login-throttle.js";
import { hashPassword, verifyPassword, verifyPasswordOrDummy } from "../domain/password-hash.js";
import { isStrongEnoughPassword } from "../domain/password-policy.js";
import type { SessionStore } from "../domain/session-store.js";
import { hashSessionToken, isSessionToken, newSessionToken } from "../domain/session-token.js";
import type { SessionUser } from "../domain/user.js";
import type { UserStore } from "../domain/user-store.js";

/** A session's expiry and cookie are refreshed at most this often, so reads do not write on every request. */
const REFRESH_INTERVAL_MS = 60_000;

export interface AuthServiceDependencies {
  readonly users: UserStore;
  readonly sessions: SessionStore;
  readonly clock: () => Date;
  /** How long a session lives after its last request. */
  readonly sessionMs: number;
  readonly throttle: LoginThrottle;
}

export interface LoginResult {
  /** The session token, for the client's cookie only. */
  readonly token: string;
  readonly user: SessionUser;
  readonly maxAgeSeconds: number;
}

/** A request's valid session. */
export interface AuthenticatedSession {
  readonly tokenHash: string;
  readonly userId: string;
  readonly user: SessionUser;
  /** The expiry was just moved: the client's cookie should be renewed too. */
  readonly refreshed: boolean;
}

export type SessionRevokedListener = (tokenHash: string) => void;

/** Sign-in, sessions and password changes (docs/API.md "Authentication"). */
export class AuthService {
  private readonly revokedListeners = new Set<SessionRevokedListener>();

  constructor(private readonly deps: AuthServiceDependencies) {}

  /** Lifetime of a session and of its cookie, in seconds. */
  get sessionMaxAgeSeconds(): number {
    return Math.floor(this.deps.sessionMs / 1000);
  }

  /**
   * Opens a session, or throws `AuthError`: `TOO_MANY_ATTEMPTS` while the username and client IP
   * are blocked (even for the right password), `INVALID_CREDENTIALS` for an unknown user and for a
   * wrong password alike.
   */
  async login(username: string, password: string, clientIp: string): Promise<LoginResult> {
    const { users, sessions, clock, sessionMs, throttle } = this.deps;
    this.countAttempt(username, clientIp);
    const user = await users.findUserByUsername(username);
    if (!(await verifyPasswordOrDummy(password, user?.passwordHash ?? null)) || user === null) {
      throw new AuthError("INVALID_CREDENTIALS");
    }
    throttle.succeeded(username, clientIp);
    const { token, tokenHash } = newSessionToken();
    const now = clock();
    await sessions.createSession({
      tokenHash,
      userId: user.id,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + sessionMs),
    });
    return { token, user: { username: user.username, role: user.role }, maxAgeSeconds: this.sessionMaxAgeSeconds };
  }

  /**
   * The session of a token, or null when there is none or it expired. Moves the expiry forward
   * (sliding) when the last refresh is at least a minute old. Rejects if the store fails: callers
   * must treat that as "not signed in".
   */
  async authenticate(token: string): Promise<AuthenticatedSession | null> {
    if (!isSessionToken(token)) return null;
    const { sessions, clock, sessionMs } = this.deps;
    const tokenHash = hashSessionToken(token);
    const session = await sessions.findSession(tokenHash);
    const now = clock();
    if (session === null || session.expiresAt.getTime() <= now.getTime()) return null;
    const refreshed = now.getTime() - session.lastSeenAt.getTime() >= REFRESH_INTERVAL_MS;
    if (refreshed) await sessions.touchSession(tokenHash, now, new Date(now.getTime() + sessionMs));
    return {
      tokenHash,
      userId: session.userId,
      user: { username: session.user.username, role: session.user.role },
      refreshed,
    };
  }

  /** Whether a session still exists and has not expired; does not slide its expiry. */
  async isActive(tokenHash: string): Promise<boolean> {
    const session = await this.deps.sessions.findSession(tokenHash);
    return session !== null && session.expiresAt.getTime() > this.deps.clock().getTime();
  }

  /** Deletes the session of a token; a missing, malformed or unknown token is not an error. */
  async logout(token: string | null): Promise<void> {
    if (token === null || !isSessionToken(token)) return;
    const tokenHash = hashSessionToken(token);
    const existed = (await this.deps.sessions.findSession(tokenHash)) !== null;
    await this.deps.sessions.deleteSession(tokenHash);
    if (existed) this.revoked([tokenHash]);
  }

  /**
   * Replaces the user's password and deletes every other session of that user. Throws `AuthError`:
   * `INVALID_CREDENTIALS` for a wrong current password (limited like failed sign-ins),
   * `WEAK_PASSWORD` for a new password that is too short or equal to the current one.
   */
  async changePassword(session: AuthenticatedSession, currentPassword: string, newPassword: string, clientIp: string): Promise<void> {
    const { users, sessions, clock, throttle } = this.deps;
    this.countAttempt(session.user.username, clientIp);
    const user = await users.findUserById(session.userId);
    if (user === null || !(await verifyPassword(currentPassword, user.passwordHash))) throw new AuthError("INVALID_CREDENTIALS");
    throttle.succeeded(session.user.username, clientIp);
    if (!isStrongEnoughPassword(newPassword) || newPassword === currentPassword) throw new AuthError("WEAK_PASSWORD");
    await users.setPasswordHash(user.id, await hashPassword(newPassword), clock());
    this.revoked(await sessions.deleteUserSessions(user.id, session.tokenHash));
  }

  /** Calls `listener` with the token hash of every session this service deletes. Returns how to stop. */
  onSessionRevoked(listener: SessionRevokedListener): () => void {
    this.revokedListeners.add(listener);
    return () => this.revokedListeners.delete(listener);
  }

  /** Deletes at most `limit` expired sessions; returns how many. */
  purgeExpired(limit: number): Promise<number> {
    return this.deps.sessions.deleteExpiredSessions(this.deps.clock(), limit);
  }

  private countAttempt(username: string, clientIp: string): void {
    const decision = this.deps.throttle.attempt(username, clientIp);
    if (!decision.allowed) throw new AuthError("TOO_MANY_ATTEMPTS", decision.retryAfterSeconds);
  }

  private revoked(tokenHashes: readonly string[]): void {
    for (const tokenHash of tokenHashes) for (const listener of this.revokedListeners) listener(tokenHash);
  }
}
