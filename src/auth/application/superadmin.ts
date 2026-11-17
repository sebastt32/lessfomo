import { randomBytes, randomUUID } from "node:crypto";
import { hashPassword } from "../domain/password-hash.js";
import type { SessionStore } from "../domain/session-store.js";
import type { UserStore } from "../domain/user-store.js";

/** 24 random bytes: 32 URL-safe characters, 192 bits. */
const PASSWORD_BYTES = 24;

export const generatePassword = (): string => randomBytes(PASSWORD_BYTES).toString("base64url");

export type SuperadminOutcome =
  | { readonly outcome: "created" | "reset"; readonly username: string; readonly password: string }
  | { readonly outcome: "exists"; readonly username: string };

/**
 * Creates a super admin with a random password, stored only as its hash and returned once.
 * An existing user is left alone unless `reset`, which sets a new password and deletes that
 * user's sessions (decision D4).
 */
export const provisionSuperadmin = async (
  stores: { readonly users: UserStore; readonly sessions: SessionStore },
  username: string,
  options: { readonly reset: boolean; readonly now: Date },
): Promise<SuperadminOutcome> => {
  const { users, sessions } = stores;
  const password = generatePassword();
  const passwordHash = await hashPassword(password);
  const created = await users.createUser({ id: randomUUID(), username, passwordHash, role: "superadmin", createdAt: options.now });
  if (created) return { outcome: "created", username, password };
  const existing = await users.findUserByUsername(username);
  if (existing === null) throw new Error(`User "${username}" could not be created`);
  if (!options.reset) return { outcome: "exists", username: existing.username };
  await users.setPasswordHash(existing.id, passwordHash, options.now);
  await sessions.deleteUserSessions(existing.id, null);
  return { outcome: "reset", username: existing.username, password };
};
