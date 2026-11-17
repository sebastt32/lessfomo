import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCRYPT_PARAMS,
  dummyPasswordHash,
  hashPassword,
  verifyPassword,
  verifyPasswordOrDummy,
} from "./password-hash.js";

/** Cheap parameters keep these tests fast; the stored format carries them, so verification follows. */
const CHEAP = { N: 1024, r: 8, p: 1 };
const PASSWORD = "correct horse battery staple";

describe("password hashing", () => {
  it("stores a self-describing scrypt hash with a random salt per call", async () => {
    const first = await hashPassword(PASSWORD, CHEAP);
    const second = await hashPassword(PASSWORD, CHEAP);

    expect(first).toMatch(/^scrypt\$1024\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/);
    expect(first).not.toBe(second);
    expect(first).not.toContain(PASSWORD);
  });

  it("uses strong parameters by default (OWASP scrypt: N=2^15, r=8, p=3)", async () => {
    expect(DEFAULT_SCRYPT_PARAMS).toEqual({ N: 32768, r: 8, p: 3 });
    expect(await hashPassword(PASSWORD)).toMatch(/^scrypt\$32768\$8\$3\$/);
  });

  it("verifies the right password and rejects a wrong one", async () => {
    const stored = await hashPassword(PASSWORD, CHEAP);

    expect(await verifyPassword(PASSWORD, stored)).toBe(true);
    expect(await verifyPassword(`${PASSWORD} `, stored)).toBe(false);
    expect(await verifyPassword("", stored)).toBe(false);
  });

  it("rejects a tampered or malformed stored hash instead of throwing", async () => {
    const stored = await hashPassword(PASSWORD, CHEAP);
    const [scheme, n, r, p, salt, hash] = stored.split("$") as [string, string, string, string, string, string];
    const flipped = hash.startsWith("A") ? `B${hash.slice(1)}` : `A${hash.slice(1)}`;

    for (const tampered of [
      [scheme, n, r, p, salt, flipped].join("$"),
      [scheme, "2048", r, p, salt, hash].join("$"),
      [scheme, n, r, p, `${salt.slice(0, -1)}_`, hash].join("$"),
      ["bcrypt", n, r, p, salt, hash].join("$"),
      [scheme, n, r, p, salt, hash.slice(0, 10)].join("$"),
      [scheme, "1000", r, p, salt, hash].join("$"),
      [scheme, String(2 ** 30), r, p, salt, hash].join("$"),
      [scheme, n, "0", p, salt, hash].join("$"),
      [scheme, n, r, "-1", salt, hash].join("$"),
      [scheme, n, r, p, salt].join("$"),
      `${stored}$extra`,
      "",
      "!",
    ]) {
      expect(await verifyPassword(PASSWORD, tampered), tampered).toBe(false);
    }
  });

  it("verifies a dummy hash for an unknown user, so the answer and the work are the same", async () => {
    const dummy = await dummyPasswordHash();

    expect(dummy).toMatch(/^scrypt\$32768\$8\$3\$/);
    expect(await dummyPasswordHash()).toBe(dummy);
    expect(await verifyPasswordOrDummy(PASSWORD, null)).toBe(false);
    expect(await verifyPasswordOrDummy("", null)).toBe(false);
    expect(await verifyPasswordOrDummy(PASSWORD, await hashPassword(PASSWORD, CHEAP))).toBe(true);
  });
});
