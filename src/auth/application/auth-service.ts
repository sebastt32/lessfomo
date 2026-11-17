import { AuthError } from "../domain/auth-error.js";
import type { LoginThrottle } from "../domain/login-throttle.js";
import { scryptPasswordHasher, type PasswordHasher } from "../domain/password-hash.js";
import { isStrongEnoughPassword } from "../domain/password-policy.js";
import type { SessionStore } from "../domain/session-store.js";
import { hashSessionToken, isSessionToken, newSessionToken } from "../domain/session-token.js";
import type { SessionUser } from "../domain/user.js";
import type { UserStore } from "../domain/user-store.js";
import { DEFAULT_SIGNED_IN_PASSWORD_WORK, WorkGate } from "../domain/work-gate.js";

/** A session's expiry and cookie are refreshed at most this often, so reads do not write on every request. */
const REFRESH_INTERVAL_MS = 60_000;

export interface AuthServiceDependencies {
  readonly users: UserStore;
  readonly sessions: SessionStore;
  readonly clock: () => Date;
  /** How long a session lives after its last request. */
  readonly sessionMs: number;
  readonly throttle: LoginThrottle;
  /** Hashes and verifies passwords; scrypt unless a test replaces it. */
  readonly passwords?: PasswordHasher;
  /** Bounds how many sign-in passwords are verified at once; 4 with 32 waiting unless given. */
  readonly passwordWork?: WorkGate;
  /** The same bound for password changes, which only signed-in users can ask for; 2 with 8 waiting unless given. */
  readonly signedInPasswordWork?: WorkGate;
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

  private readonly passwords: PasswordHasher;
  private readonly passwordWork: WorkGate;
  private readonly signedInPasswordWork: WorkGate;

  constructor(private readonly deps: AuthServiceDependencies) {
    this.passwords = deps.passwords ?? scryptPasswordHasher;
    this.passwordWork = deps.passwordWork ?? new WorkGate();
    this.signedInPasswordWork = deps.signedInPasswordWork ?? new WorkGate(DEFAULT_SIGNED_IN_PASSWORD_WORK);
  }

  /** Lifetime of a session and of its cookie, in seconds. */
  get sessionMaxAgeSeconds(): number {
    return Math.floor(this.deps.sessionMs / 1000);
  }

  /**
   * Opens a session, or throws `AuthError`: `TOO_MANY_ATTEMPTS` while the username and client IP,
   * or the client IP alone, are blocked (even for the right password), `SERVER_BUSY` when too many
   * passwords are being checked (nothing is hashed), `INVALID_CREDENTIALS` for an unknown user and
   * for a wrong password alike.
   *
   * The session is stored only if the user still has the password hash that was verified, so a
   * sign-in that overlaps a password change or reset never leaves a session for the old password.
   */
  async login(username: string, password: string, clientIp: string): Promise<LoginResult> {
    const { users, sessions, clock, sessionMs, throttle } = this.deps;
    this.countAttempt(username, clientIp);
    const user = await users.findUserByUsername(username);
    const matches = await this.verify(this.passwordWork, password, user?.passwordHash ?? null, username, clientIp);
    if (!matches || user === null) throw new AuthError("INVALID_CREDENTIALS");
    const { token, tokenHash } = newSessionToken();
    const now = clock();
    const session = { tokenHash, userId: user.id, createdAt: now, lastSeenAt: now, expiresAt: new Date(now.getTime() + sessionMs) };
    // The password was replaced while it was being verified: what was verified is no longer the credential.
    if (!(await sessions.createVerifiedSession(session, user.passwordHash))) throw new AuthError("INVALID_CREDENTIALS");
    throttle.succeeded(username, clientIp);
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
   * Replaces the user's password and ends every other session of that user, in one step: when it
   * resolves, no session opened with the old password is valid. Throws `AuthError`:
   * `INVALID_CREDENTIALS` for a wrong current password (limited like failed sign-ins) or one that
   * was replaced meanwhile, `WEAK_PASSWORD` for a new password that is too short or equal to the
   * current one, `SERVER_BUSY` like `login`.
   */
  async changePassword(session: AuthenticatedSession, currentPassword: string, newPassword: string, clientIp: string): Promise<void> {
    const { users, clock, throttle } = this.deps;
    this.countAttempt(session.user.username, clientIp);
    const user = await users.findUserById(session.userId);
    const work = this.signedInPasswordWork;
    const matches = await this.verify(work, currentPassword, user?.passwordHash ?? null, session.user.username, clientIp);
    if (!matches || user === null) throw new AuthError("INVALID_CREDENTIALS");
    throttle.succeeded(session.user.username, clientIp);
    if (!isStrongEnoughPassword(newPassword) || newPassword === currentPassword) throw new AuthError("WEAK_PASSWORD");
    const passwordHash = await work.run(() => this.passwords.hash(newPassword));
    const revoked = await users.replacePassword({
      userId: user.id,
      passwordHash,
      updatedAt: clock(),
      expectedPasswordHash: user.passwordHash,
      keepTokenHash: session.tokenHash,
    });
    // Somebody else replaced the password first: the one verified above is not the current one any more.
    if (revoked === null) throw new AuthError("INVALID_CREDENTIALS");
    this.revoked(revoked);
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

  /**
   * Verifies a password within the bound on concurrent password work. A refusal for being busy
   * checked nothing, so it is not counted as a failed attempt.
   */
  private async verify(work: WorkGate, password: string, stored: string | null, username: string, clientIp: string): Promise<boolean> {
    try {
      return await work.run(() => this.passwords.verify(password, stored));
    } catch (error) {
      if (error instanceof AuthError && error.code === "SERVER_BUSY") this.deps.throttle.forgive(username, clientIp);
      throw error;
    }
  }

  private countAttempt(username: string, clientIp: string): void {
    const decision = this.deps.throttle.attempt(username, clientIp);
    if (!decision.allowed) throw new AuthError("TOO_MANY_ATTEMPTS", decision.retryAfterSeconds);
  }

  private revoked(tokenHashes: readonly string[]): void {
    for (const tokenHash of tokenHashes) for (const listener of this.revokedListeners) listener(tokenHash);
  }
}
