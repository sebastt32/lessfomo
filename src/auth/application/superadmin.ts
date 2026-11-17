import { randomBytes, randomUUID } from "node:crypto";
import { hashPassword } from "../domain/password-hash.js";
import type { UserStore } from "../domain/user-store.js";

/** 24 random bytes: 32 URL-safe characters, 192 bits. */
const PASSWORD_BYTES = 24;

export const generatePassword = (): string => randomBytes(PASSWORD_BYTES).toString("base64url");

export type SuperadminOutcome =
  | { readonly outcome: "created" | "reset"; readonly username: string; readonly password: string }
  | { readonly outcome: "exists"; readonly username: string };

/**
 * Creates a super admin with a random password, stored only as its hash and returned once.
 * An existing user is left alone unless `reset`, which sets a new password and ends that user's
 * sessions in one step (decision D4): a sign-in under way with the old password, in the running
 * app, opens no valid session.
 */
export const provisionSuperadmin = async (
  stores: { readonly users: UserStore },
  username: string,
  options: { readonly reset: boolean; readonly now: Date },
): Promise<SuperadminOutcome> => {
  const { users } = stores;
  const password = generatePassword();
  const passwordHash = await hashPassword(password);
  const created = await users.createUser({ id: randomUUID(), username, passwordHash, role: "superadmin", createdAt: options.now });
  if (created) return { outcome: "created", username, password };
  const existing = await users.findUserByUsername(username);
  if (existing === null) throw new Error(`User "${username}" could not be created`);
  if (!options.reset) return { outcome: "exists", username: existing.username };
  const replaced = await users.replacePassword({
    userId: existing.id,
    passwordHash,
    updatedAt: options.now,
    expectedPasswordHash: null,
    keepTokenHash: null,
  });
  if (replaced === null) throw new Error(`User "${username}" no longer exists`);
  return { outcome: "reset", username: existing.username, password };
};
