import type { Role, User } from "./user.js";

export interface NewUser {
  readonly id: string;
  readonly username: string;
  readonly passwordHash: string;
  readonly role: Role;
  readonly createdAt: Date;
}

export interface PasswordChange {
  readonly userId: string;
  readonly passwordHash: string;
  readonly updatedAt: Date;
  /** The hash the change was authorized against: it applies only while the user still has it. Null applies always. */
  readonly expectedPasswordHash: string | null;
  /** The one session of the user that stays valid, if it was valid until now. */
  readonly keepTokenHash: string | null;
}

/** Port: where users are kept. */
export interface UserStore {
  /** Stores the user; false (and nothing stored) when the username is taken, ignoring case. */
  createUser(user: NewUser): Promise<boolean>;
  /** The user with that username, ignoring case. */
  findUserByUsername(username: string): Promise<User | null>;
  findUserById(id: string): Promise<User | null>;
  /** Replaces the hash; no session of the user is valid afterwards (see `replacePassword` to keep one). */
  setPasswordHash(userId: string, passwordHash: string, updatedAt: Date): Promise<void>;
  /**
   * Replaces the hash and ends the user's sessions in one step: once it resolves, no session opened
   * with an earlier password is valid, not even one stored later by a sign-in that was under way,
   * and the other sessions are deleted. Returns the deleted token hashes, or null (nothing changed)
   * when the user does not exist or no longer has `expectedPasswordHash`.
   */
  replacePassword(change: PasswordChange): Promise<string[] | null>;
}
