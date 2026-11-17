import type { Session, SessionWithUser } from "./user.js";

/** Port: where sessions are kept, by the hash of their token. */
export interface SessionStore {
  createSession(session: Session): Promise<void>;
  /** The session and its user, expired or not; the caller compares `expiresAt` with its clock. */
  findSession(tokenHash: string): Promise<SessionWithUser | null>;
  /** Moves the last request time and the expiry of a session (sliding expiry). */
  touchSession(tokenHash: string, lastSeenAt: Date, expiresAt: Date): Promise<void>;
  deleteSession(tokenHash: string): Promise<void>;
  /** Deletes every session of a user except `exceptTokenHash`; returns the deleted token hashes. */
  deleteUserSessions(userId: string, exceptTokenHash: string | null): Promise<string[]>;
  /** Deletes at most `limit` sessions that expired at or before `now`, oldest first; returns how many. */
  deleteExpiredSessions(now: Date, limit: number): Promise<number>;
}
