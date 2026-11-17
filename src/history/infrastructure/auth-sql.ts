import type { NewUser } from "../../auth/domain/user-store.js";
import type { Role, Session, SessionWithUser, User } from "../../auth/domain/user.js";
import type { Statement } from "./catalog-sql.js";
import { toDate, type ChartDialect, type Row } from "./history-rows.js";

/**
 * SQL and row mapping of users and sessions (docs/API.md "Authentication"), shared by every
 * adapter so both engines answer identically. Both tables are new and created on startup in older
 * databases too; no existing table is touched. Usernames are ASCII, so `LOWER` agrees everywhere.
 */
export const authDdl = (types: { time: string }): string => `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at ${types.time} NOT NULL,
  updated_at ${types.time} NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower ON users (LOWER(username));

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at ${types.time} NOT NULL,
  expires_at ${types.time} NOT NULL,
  last_seen_at ${types.time} NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions (expires_at);
`;

const USER_COLUMNS = "id, username, password_hash, role, created_at, updated_at";

const list = (dialect: ChartDialect, count: number): string =>
  Array.from({ length: count }, (_, index) => dialect.param(index + 1)).join(", ");

/** Returns a row only when the user was stored (the username was free). */
export const createUserStatement = (dialect: ChartDialect, user: NewUser): Statement => ({
  sql: `INSERT INTO users (${USER_COLUMNS}) VALUES (${list(dialect, 6)}) ON CONFLICT DO NOTHING RETURNING id`,
  params: [user.id, user.username, user.passwordHash, user.role, user.createdAt.getTime(), user.createdAt.getTime()],
});

export const userByUsernameStatement = (dialect: ChartDialect, username: string): Statement => ({
  sql: `SELECT ${USER_COLUMNS} FROM users WHERE LOWER(username) = LOWER(${dialect.param(1)})`,
  params: [username],
});

export const userByIdStatement = (dialect: ChartDialect, id: string): Statement => ({
  sql: `SELECT ${USER_COLUMNS} FROM users WHERE id = ${dialect.param(1)}`,
  params: [id],
});

export const setPasswordHashStatement = (dialect: ChartDialect, userId: string, passwordHash: string, updatedAt: Date): Statement => ({
  sql: `UPDATE users SET password_hash = ${dialect.param(1)}, updated_at = ${dialect.param(2)} WHERE id = ${dialect.param(3)}`,
  params: [passwordHash, updatedAt.getTime(), userId],
});

export const createSessionStatement = (dialect: ChartDialect, session: Session): Statement => ({
  sql: `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at) VALUES (${list(dialect, 5)})`,
  params: [session.tokenHash, session.userId, session.createdAt.getTime(), session.expiresAt.getTime(), session.lastSeenAt.getTime()],
});

export const sessionStatement = (dialect: ChartDialect, tokenHash: string): Statement => ({
  sql: `SELECT s.token_hash, s.user_id, s.created_at, s.expires_at, s.last_seen_at, u.username, u.role
        FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ${dialect.param(1)}`,
  params: [tokenHash],
});

export const touchSessionStatement = (dialect: ChartDialect, tokenHash: string, lastSeenAt: Date, expiresAt: Date): Statement => ({
  sql: `UPDATE sessions SET last_seen_at = ${dialect.param(1)}, expires_at = ${dialect.param(2)} WHERE token_hash = ${dialect.param(3)}`,
  params: [lastSeenAt.getTime(), expiresAt.getTime(), tokenHash],
});

export const deleteSessionStatement = (dialect: ChartDialect, tokenHash: string): Statement => ({
  sql: `DELETE FROM sessions WHERE token_hash = ${dialect.param(1)}`,
  params: [tokenHash],
});

/** Returns the deleted token hashes. No hash is empty, so "" keeps nothing. */
export const deleteUserSessionsStatement = (dialect: ChartDialect, userId: string, exceptTokenHash: string | null): Statement => ({
  sql: `DELETE FROM sessions WHERE user_id = ${dialect.param(1)} AND token_hash <> ${dialect.param(2)} RETURNING token_hash`,
  params: [userId, exceptTokenHash ?? ""],
});

/** Returns the deleted token hashes: at most `limit`, the longest expired first. */
export const deleteExpiredSessionsStatement = (dialect: ChartDialect, now: Date, limit: number): Statement => ({
  sql: `DELETE FROM sessions WHERE token_hash IN (
          SELECT token_hash FROM sessions WHERE expires_at <= ${dialect.param(1)} ORDER BY expires_at, token_hash LIMIT ${dialect.param(2)}
        ) RETURNING token_hash`,
  params: [now.getTime(), limit],
});

export const toUser = (row: Row): User => ({
  id: String(row["id"]),
  username: String(row["username"]),
  passwordHash: String(row["password_hash"]),
  role: row["role"] as Role,
  createdAt: toDate(row["created_at"]),
  updatedAt: toDate(row["updated_at"]),
});

export const toSessionWithUser = (row: Row): SessionWithUser => ({
  tokenHash: String(row["token_hash"]),
  userId: String(row["user_id"]),
  createdAt: toDate(row["created_at"]),
  expiresAt: toDate(row["expires_at"]),
  lastSeenAt: toDate(row["last_seen_at"]),
  user: { id: String(row["user_id"]), username: String(row["username"]), role: row["role"] as Role },
});
