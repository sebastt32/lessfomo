import type { Session, SessionWithUser } from "./user.js";

/** Port: where sessions are kept, by the hash of their token. */
export interface SessionStore {
  /** Stores a session valid for the user's current password, without checking any: never for a sign-in. */
  createSession(session: Session): Promise<void>;
  /**
   * Stores the session of a sign-in, only if the user's password hash is still `verifiedPasswordHash`
   * (the one the password was checked against). False, and nothing stored, when the password was
   * replaced in the meantime or the user is gone.
   */
  createVerifiedSession(session: Session, verifiedPasswordHash: string): Promise<boolean>;
  /**
   * The session and its user, expired or not; the caller compares `expiresAt` with its clock.
   * Null for a session opened with a password the user no longer has.
   */
  findSession(tokenHash: string): Promise<SessionWithUser | null>;
  /** Moves the last request time and the expiry of a session (sliding expiry). */
  touchSession(tokenHash: string, lastSeenAt: Date, expiresAt: Date): Promise<void>;
  deleteSession(tokenHash: string): Promise<void>;
  /** Deletes every session of a user except `exceptTokenHash`; returns the deleted token hashes. */
  deleteUserSessions(userId: string, exceptTokenHash: string | null): Promise<string[]>;
  /** Deletes at most `limit` sessions that expired at or before `now`, oldest first; returns how many. */
  deleteExpiredSessions(now: Date, limit: number): Promise<number>;
}
