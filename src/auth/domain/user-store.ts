import type { Role, User } from "./user.js";

export interface NewUser {
  readonly id: string;
  readonly username: string;
  readonly passwordHash: string;
  readonly role: Role;
  readonly createdAt: Date;
}

/** Port: where users are kept. */
export interface UserStore {
  /** Stores the user; false (and nothing stored) when the username is taken, ignoring case. */
  createUser(user: NewUser): Promise<boolean>;
  /** The user with that username, ignoring case. */
  findUserByUsername(username: string): Promise<User | null>;
  findUserById(id: string): Promise<User | null>;
  setPasswordHash(userId: string, passwordHash: string, updatedAt: Date): Promise<void>;
}
