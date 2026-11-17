/** The only role for now: there is no public sign-up and every user is created on the server. */
export type Role = "superadmin";

export interface User {
  readonly id: string;
  /** Unique ignoring case; stored as first written. */
  readonly username: string;
  /** Self-describing scrypt hash (`password-hash.ts`), never the password. */
  readonly passwordHash: string;
  readonly role: Role;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** What the API tells a signed-in client about itself (docs/API.md `SessionUser`). */
export interface SessionUser {
  readonly username: string;
  readonly role: Role;
}

export interface Session {
  /** SHA-256 of the session token; the token itself is never stored. */
  readonly tokenHash: string;
  readonly userId: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly lastSeenAt: Date;
}

export interface SessionWithUser extends Session {
  readonly user: { readonly id: string; readonly username: string; readonly role: Role };
}

export const MAX_USERNAME_LENGTH = 64;

/** ASCII only, so "unique ignoring case" means the same in SQLite and PostgreSQL. */
const USERNAME = /^[A-Za-z0-9._-]{1,64}$/;

/** A username that may be created: 1 to 64 letters, digits, dots, dashes or underscores. */
export const isValidUsername = (username: string): boolean => USERNAME.test(username);
