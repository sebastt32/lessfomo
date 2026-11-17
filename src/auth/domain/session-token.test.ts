import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashSessionToken, isSessionToken, newSessionToken } from "./session-token.js";

describe("session tokens", () => {
  it("creates 32 random bytes as a URL-safe token and only its SHA-256 is meant to be stored", () => {
    const first = newSessionToken();
    const second = newSessionToken();

    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(first.token, "base64url")).toHaveLength(32);
    expect(first.token).not.toBe(second.token);
    expect(first.tokenHash).toBe(createHash("sha256").update(first.token).digest("hex"));
    expect(first.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.tokenHash).not.toContain(first.token);
    expect(hashSessionToken(first.token)).toBe(first.tokenHash);
  });

  it("recognizes only well-formed tokens", () => {
    expect(isSessionToken(newSessionToken().token)).toBe(true);
    for (const bad of ["", "short", "a".repeat(42), "a".repeat(44), `${"a".repeat(42)}=`, `${"a".repeat(42)} `, `${"a".repeat(42)}+`]) {
      expect(isSessionToken(bad), bad).toBe(false);
    }
  });
});
