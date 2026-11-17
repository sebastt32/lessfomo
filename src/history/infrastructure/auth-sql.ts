import type { NewUser, PasswordChange } from "../../auth/domain/user-store.js";
import type { Role, Session, SessionWithUser, User } from "../../auth/domain/user.js";
import type { CatalogDialect, Statement } from "./catalog-sql.js";
import { toDate, type ChartDialect, type Row } from "./history-rows.js";
import type { AddedColumn } from "./wallet-reputation-sql.js";

/**
 * SQL and row mapping of users and sessions (docs/API.md "Authentication"), shared by every
 * adapter so both engines answer identically. Both tables are new and created on startup in older
 * databases too; no existing table is touched. Usernames are ASCII, so `LOWER` agrees everywhere.
 *
 * Credential versions: `users.credential_version` grows by one in the same statement that replaces
 * a password hash, and every session carries the version it was opened with. A session is found
 * only while both are equal, so replacing a password ends every session opened with an earlier one
 * at that instant, including a session whose row is written later by a sign-in that had already
 * read the old hash. Neither engine needs a lock for that.
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

/** Columns added after the tables first shipped: each adapter adds them once, after `authDdl`. */
export const AUTH_ADDED_COLUMNS: AddedColumn[] = [
  { table: "users", column: "credential_version", definition: "INTEGER NOT NULL DEFAULT 0" },
  { table: "sessions", column: "credential_version", definition: "INTEGER NOT NULL DEFAULT 0" },
];

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

const SET_PASSWORD = (dialect: ChartDialect): string =>
  `UPDATE users SET password_hash = ${dialect.param(1)}, updated_at = ${dialect.param(2)}, credential_version = credential_version + 1
   WHERE id = ${dialect.param(3)}`;

/** Also ends every session of the user: none carries the new credential version. */
export const setPasswordHashStatement = (dialect: ChartDialect, userId: string, passwordHash: string, updatedAt: Date): Statement => ({
  sql: SET_PASSWORD(dialect),
  params: [passwordHash, updatedAt.getTime(), userId],
});

/**
 * First statement of a password replacement. Returns a row only when it applied: the user exists
 * and, when a hash is expected, still has exactly that hash.
 */
export const replacePasswordStatement = (dialect: ChartDialect, change: PasswordChange): Statement => {
  const params = [change.passwordHash, change.updatedAt.getTime(), change.userId];
  if (change.expectedPasswordHash === null) return { sql: `${SET_PASSWORD(dialect)} RETURNING id`, params };
  return {
    sql: `${SET_PASSWORD(dialect)} AND password_hash = ${dialect.param(4)} RETURNING id`,
    params: [...params, change.expectedPasswordHash],
  };
};

/**
 * Second statement, in the same transaction: moves one session to the user's new credential
 * version, only if it was valid until this replacement (a session from older credentials stays dead).
 */
export const keepSessionStatement = (dialect: ChartDialect, userId: string, tokenHash: string): Statement => {
  const current = `(SELECT credential_version FROM users WHERE id = ${dialect.param(1)})`;
  return {
    sql: `UPDATE sessions SET credential_version = ${current}
          WHERE user_id = ${dialect.param(1)} AND token_hash = ${dialect.param(2)} AND credential_version = ${current} - 1`,
    params: [userId, tokenHash],
  };
};

const SESSION_COLUMNS = "token_hash, user_id, created_at, expires_at, last_seen_at, credential_version";

const sessionParams = (session: Session): (string | number)[] => [
  session.tokenHash,
  session.userId,
  session.createdAt.getTime(),
  session.expiresAt.getTime(),
  session.lastSeenAt.getTime(),
];

/** A session with the user's current credential version, whatever its password: not for sign-ins. */
export const createSessionStatement = (dialect: ChartDialect, session: Session): Statement => ({
  sql: `INSERT INTO sessions (${SESSION_COLUMNS})
        VALUES (${list(dialect, 5)}, COALESCE((SELECT credential_version FROM users WHERE id = ${dialect.param(2)}), 0))`,
  params: sessionParams(session),
});

/**
 * The session of a sign-in: stored, with the user's credential version, only if the user's
 * password hash is still the one that was verified. Returns a row only when it was stored.
 */
export const createVerifiedSessionStatement = (dialect: CatalogDialect, session: Session, verifiedPasswordHash: string): Statement => ({
  sql: `INSERT INTO sessions (${SESSION_COLUMNS})
        SELECT ${dialect.typed(1, "text")}, u.id, ${dialect.typed(3, "bigint")}, ${dialect.typed(4, "bigint")}, ${dialect.typed(5, "bigint")},
               u.credential_version
        FROM users u WHERE u.id = ${dialect.param(2)} AND u.password_hash = ${dialect.param(6)}
        RETURNING token_hash`,
  params: [...sessionParams(session), verifiedPasswordHash],
});

/** Only a session opened with the user's current credentials. */
export const sessionStatement = (dialect: ChartDialect, tokenHash: string): Statement => ({
  sql: `SELECT s.token_hash, s.user_id, s.created_at, s.expires_at, s.last_seen_at, u.username, u.role
        FROM sessions s JOIN users u ON u.id = s.user_id AND u.credential_version = s.credential_version
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
