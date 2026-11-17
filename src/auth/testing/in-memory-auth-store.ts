import type { SessionStore } from "../domain/session-store.js";
import type { Session, SessionWithUser, User } from "../domain/user.js";
import type { NewUser, UserStore } from "../domain/user-store.js";

/** Users and sessions kept in memory, for tests that do not need a database. */
export class InMemoryAuthStore implements UserStore, SessionStore {
  private readonly users = new Map<string, User>();
  private readonly sessions = new Map<string, Session>();

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
    if (user !== undefined) this.users.set(userId, { ...user, passwordHash, updatedAt });
  }

  async createSession(session: Session): Promise<void> {
    if (this.sessions.has(session.tokenHash)) throw new Error("session already exists");
    this.sessions.set(session.tokenHash, session);
  }

  async findSession(tokenHash: string): Promise<SessionWithUser | null> {
    const session = this.sessions.get(tokenHash);
    const user = session === undefined ? undefined : this.users.get(session.userId);
    if (session === undefined || user === undefined) return null;
    return { ...session, user: { id: user.id, username: user.username, role: user.role } };
  }

  async touchSession(tokenHash: string, lastSeenAt: Date, expiresAt: Date): Promise<void> {
    const session = this.sessions.get(tokenHash);
    if (session !== undefined) this.sessions.set(tokenHash, { ...session, lastSeenAt, expiresAt });
  }

  async deleteSession(tokenHash: string): Promise<void> {
    this.sessions.delete(tokenHash);
  }

  async deleteUserSessions(userId: string, exceptTokenHash: string | null): Promise<string[]> {
    const deleted = [...this.sessions.values()]
      .filter((session) => session.userId === userId && session.tokenHash !== exceptTokenHash)
      .map((session) => session.tokenHash);
    for (const tokenHash of deleted) this.sessions.delete(tokenHash);
    return deleted;
  }

  async deleteExpiredSessions(now: Date, limit: number): Promise<number> {
    const expired = [...this.sessions.values()]
      .filter((session) => session.expiresAt.getTime() <= now.getTime())
      .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime())
      .slice(0, limit);
    for (const session of expired) this.sessions.delete(session.tokenHash);
    return expired.length;
  }

  /** Everything stored, for assertions. */
  dump(): { users: User[]; sessions: Session[] } {
    return { users: [...this.users.values()], sessions: [...this.sessions.values()] };
  }
}
