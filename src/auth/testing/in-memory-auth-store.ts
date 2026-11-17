import type { SessionStore } from "../domain/session-store.js";
import type { Session, SessionWithUser, User } from "../domain/user.js";
import type { NewUser, PasswordChange, UserStore } from "../domain/user-store.js";

/** Users and sessions kept in memory, for tests that do not need a database. */
export class InMemoryAuthStore implements UserStore, SessionStore {
  private readonly users = new Map<string, User>();
  private readonly sessions = new Map<string, Session>();
  /** Grows with every password replacement of a user; a session is valid only with the user's current one. */
  private readonly userVersions = new Map<string, number>();
  private readonly sessionVersions = new Map<string, number>();

  async createUser(user: NewUser): Promise<boolean> {
    if ((await this.findUserByUsername(user.username)) !== null || this.users.has(user.id)) return false;
    this.users.set(user.id, { ...user, updatedAt: user.createdAt });
    return true;
  }

  async findUserByUsername(username: string): Promise<User | null> {
    const wanted = username.toLowerCase();
    return [...this.users.values()].find((user) => user.username.toLowerCase() === wanted) ?? null;
  }

  async findUserById(id: string): Promise<User | null> {
    return this.users.get(id) ?? null;
  }

  async setPasswordHash(userId: string, passwordHash: string, updatedAt: Date): Promise<void> {
    const user = this.users.get(userId);
    if (user === undefined) return;
    this.users.set(userId, { ...user, passwordHash, updatedAt });
    this.userVersions.set(userId, this.versionOf(userId) + 1);
  }

  async replacePassword(change: PasswordChange): Promise<string[] | null> {
    const user = this.users.get(change.userId);
    if (user === undefined) return null;
    if (change.expectedPasswordHash !== null && user.passwordHash !== change.expectedPasswordHash) return null;
    const previous = this.versionOf(user.id);
    await this.setPasswordHash(user.id, change.passwordHash, change.updatedAt);
    if (change.keepTokenHash !== null && this.sessions.get(change.keepTokenHash)?.userId === user.id) {
      if (this.sessionVersions.get(change.keepTokenHash) === previous) this.sessionVersions.set(change.keepTokenHash, previous + 1);
    }
    return this.deleteUserSessions(user.id, change.keepTokenHash);
  }

  async createSession(session: Session): Promise<void> {
    if (this.sessions.has(session.tokenHash)) throw new Error("session already exists");
    this.sessions.set(session.tokenHash, session);
    this.sessionVersions.set(session.tokenHash, this.versionOf(session.userId));
  }

  async createVerifiedSession(session: Session, verifiedPasswordHash: string): Promise<boolean> {
    if (this.users.get(session.userId)?.passwordHash !== verifiedPasswordHash) return false;
    await this.createSession(session);
    return true;
  }

  async findSession(tokenHash: string): Promise<SessionWithUser | null> {
    const session = this.sessions.get(tokenHash);
    const user = session === undefined ? undefined : this.users.get(session.userId);
    if (session === undefined || user === undefined) return null;
    if (this.sessionVersions.get(tokenHash) !== this.versionOf(user.id)) return null;
    return { ...session, user: { id: user.id, username: user.username, role: user.role } };
  }

  async touchSession(tokenHash: string, lastSeenAt: Date, expiresAt: Date): Promise<void> {
    const session = this.sessions.get(tokenHash);
    if (session !== undefined) this.sessions.set(tokenHash, { ...session, lastSeenAt, expiresAt });
  }

  async deleteSession(tokenHash: string): Promise<void> {
    this.sessions.delete(tokenHash);
    this.sessionVersions.delete(tokenHash);
  }

  async deleteUserSessions(userId: string, exceptTokenHash: string | null): Promise<string[]> {
    const deleted = [...this.sessions.values()]
      .filter((session) => session.userId === userId && session.tokenHash !== exceptTokenHash)
      .map((session) => session.tokenHash);
    for (const tokenHash of deleted) await this.deleteSession(tokenHash);
    return deleted;
  }

  async deleteExpiredSessions(now: Date, limit: number): Promise<number> {
    const expired = [...this.sessions.values()]
      .filter((session) => session.expiresAt.getTime() <= now.getTime())
      .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime())
      .slice(0, limit);
    for (const session of expired) await this.deleteSession(session.tokenHash);
    return expired.length;
  }

  private versionOf(userId: string): number {
    return this.userVersions.get(userId) ?? 0;
  }

  /** Everything stored, for assertions. */
  dump(): { users: User[]; sessions: Session[] } {
    return { users: [...this.users.values()], sessions: [...this.sessions.values()] };
  }
}
