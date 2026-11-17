import { describe, expect, it } from "vitest";
import { AuthError } from "../domain/auth-error.js";
import { LoginThrottle } from "../domain/login-throttle.js";
import { hashPassword, verifyPassword } from "../domain/password-hash.js";
import { hashSessionToken } from "../domain/session-token.js";
import { InMemoryAuthStore } from "../testing/in-memory-auth-store.js";
import { AuthService } from "./auth-service.js";

const CHEAP = { N: 1024, r: 8, p: 1 };
const PASSWORD = "first-password-123";
const DAY = 24 * 60 * 60_000;
const IP = "203.0.113.7";

const setup = async () => {
  let now = Date.parse("2026-11-17T10:00:00.000Z");
  const clock = () => new Date(now);
  const store = new InMemoryAuthStore();
  await store.createUser({
    id: "u1",
    username: "SuperAdmin",
    passwordHash: await hashPassword(PASSWORD, CHEAP),
    role: "superadmin",
    createdAt: clock(),
  });
  const auth = new AuthService({ users: store, sessions: store, clock, sessionMs: 7 * DAY, throttle: new LoginThrottle(clock) });
  const revoked: string[] = [];
  auth.onSessionRevoked((tokenHash) => revoked.push(tokenHash));
  return { auth, store, revoked, clock, advance: (ms: number) => void (now += ms) };
};

const codeOf = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    if (error instanceof AuthError) return error.code;
    throw error;
  }
  return "no error";
};

describe("AuthService", () => {
  it("signs in with the right password, any username case, and stores only the token hash", async () => {
    const { auth, store, clock } = await setup();

    const result = await auth.login("superadmin", PASSWORD, IP);

    expect(result.user).toEqual({ username: "SuperAdmin", role: "superadmin" });
    expect(result.maxAgeSeconds).toBe(7 * 24 * 3600);
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = await store.findSession(hashSessionToken(result.token));
    expect(stored).toMatchObject({
      userId: "u1",
      createdAt: clock(),
      lastSeenAt: clock(),
      expiresAt: new Date(clock().getTime() + 7 * DAY),
    });
    expect(JSON.stringify(store.dump())).not.toContain(result.token);
  });

  it("answers the same INVALID_CREDENTIALS for an unknown user and a wrong password, creating no session", async () => {
    const { auth, store } = await setup();

    expect(await codeOf(auth.login("superadmin", "wrong-password-123", IP))).toBe("INVALID_CREDENTIALS");
    expect(await codeOf(auth.login("nobody", PASSWORD, IP))).toBe("INVALID_CREDENTIALS");
    expect(store.dump().sessions).toEqual([]);
  });

  it("blocks the sixth failed sign-in of a username and client IP with the seconds left, even with the right password", async () => {
    const { auth, advance } = await setup();
    for (let i = 0; i < 5; i += 1) expect(await codeOf(auth.login("superadmin", "wrong-password-123", IP))).toBe("INVALID_CREDENTIALS");
    advance(60_000);

    const blocked = await auth.login("superadmin", PASSWORD, IP).catch((error: unknown) => error);

    expect(blocked).toBeInstanceOf(AuthError);
    expect(blocked).toMatchObject({ code: "TOO_MANY_ATTEMPTS", retryAfterSeconds: 14 * 60 });
    // Another client IP is counted apart, and the window ends.
    expect((await auth.login("superadmin", PASSWORD, "198.51.100.1")).user.username).toBe("SuperAdmin");
    advance(14 * 60_000);
    expect((await auth.login("superadmin", PASSWORD, IP)).user.username).toBe("SuperAdmin");
  });

  it("forgets failed attempts after a successful sign-in", async () => {
    const { auth } = await setup();
    for (let i = 0; i < 4; i += 1) await codeOf(auth.login("superadmin", "wrong-password-123", IP));

    await auth.login("superadmin", PASSWORD, IP);

    for (let i = 0; i < 5; i += 1) expect(await codeOf(auth.login("superadmin", "wrong-password-123", IP))).toBe("INVALID_CREDENTIALS");
    expect(await codeOf(auth.login("superadmin", PASSWORD, IP))).toBe("TOO_MANY_ATTEMPTS");
  });

  it("authenticates a session token and nothing else", async () => {
    const { auth } = await setup();
    const { token } = await auth.login("superadmin", PASSWORD, IP);

    expect(await auth.authenticate(token)).toEqual({
      tokenHash: hashSessionToken(token),
      userId: "u1",
      user: { username: "SuperAdmin", role: "superadmin" },
      refreshed: false,
    });
    expect(await auth.authenticate(hashSessionToken(token))).toBeNull();
    expect(await auth.authenticate(`${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`)).toBeNull();
    expect(await auth.authenticate("")).toBeNull();
  });

  it("slides the expiry at most once per minute and rejects an expired session", async () => {
    const { auth, store, clock, advance } = await setup();
    const { token } = await auth.login("superadmin", PASSWORD, IP);
    const tokenHash = hashSessionToken(token);
    const loginAt = clock().getTime();

    advance(59_000);
    expect((await auth.authenticate(token))?.refreshed).toBe(false);
    expect((await store.findSession(tokenHash))?.expiresAt).toEqual(new Date(loginAt + 7 * DAY));

    advance(1_000);
    expect((await auth.authenticate(token))?.refreshed).toBe(true);
    expect(await store.findSession(tokenHash)).toMatchObject({
      lastSeenAt: clock(),
      expiresAt: new Date(clock().getTime() + 7 * DAY),
      createdAt: new Date(loginAt),
    });
    expect((await auth.authenticate(token))?.refreshed).toBe(false);

    advance(7 * DAY - 1);
    expect(await auth.isActive(tokenHash)).toBe(true);
    advance(1);
    expect(await auth.isActive(tokenHash)).toBe(false);
    expect(await auth.authenticate(token)).toBeNull();
  });

  it("signs out: deletes the session, tells listeners, and tolerates a missing or unknown token", async () => {
    const { auth, store, revoked } = await setup();
    const { token } = await auth.login("superadmin", PASSWORD, IP);

    await auth.logout(token);
    await auth.logout(token);
    await auth.logout(null);
    await auth.logout("garbage");

    expect(await auth.authenticate(token)).toBeNull();
    expect(store.dump().sessions).toEqual([]);
    expect(revoked).toEqual([hashSessionToken(token)]);
  });

  it("changes the password, keeps the current session and deletes the user's other sessions", async () => {
    const { auth, store, revoked } = await setup();
    const current = await auth.login("superadmin", PASSWORD, IP);
    const other = await auth.login("superadmin", PASSWORD, "198.51.100.1");
    const session = (await auth.authenticate(current.token))!;

    await auth.changePassword(session, PASSWORD, "second-password-456", IP);

    expect(await auth.authenticate(current.token)).not.toBeNull();
    expect(await auth.authenticate(other.token)).toBeNull();
    expect(revoked).toEqual([hashSessionToken(other.token)]);
    const user = (await store.findUserById("u1"))!;
    expect(user.passwordHash).toMatch(/^scrypt\$32768\$8\$3\$/);
    expect(await verifyPassword("second-password-456", user.passwordHash)).toBe(true);
    expect(await codeOf(auth.login("superadmin", PASSWORD, IP))).toBe("INVALID_CREDENTIALS");
    expect((await auth.login("superadmin", "second-password-456", IP)).user.role).toBe("superadmin");
  });

  it("refuses a wrong current password, a short new password and an unchanged password, changing nothing", async () => {
    const { auth, store } = await setup();
    const { token } = await auth.login("superadmin", PASSWORD, IP);
    const other = await auth.login("superadmin", PASSWORD, IP);
    const session = (await auth.authenticate(token))!;
    const before = (await store.findUserById("u1"))!.passwordHash;

    expect(await codeOf(auth.changePassword(session, "wrong-password-123", "second-password-456", IP))).toBe("INVALID_CREDENTIALS");
    expect(await codeOf(auth.changePassword(session, PASSWORD, "short-11chr", IP))).toBe("WEAK_PASSWORD");
    expect(await codeOf(auth.changePassword(session, PASSWORD, PASSWORD, IP))).toBe("WEAK_PASSWORD");

    expect((await store.findUserById("u1"))!.passwordHash).toBe(before);
    expect(await auth.authenticate(other.token)).not.toBeNull();
  });

  it("purges expired sessions only, a bounded number per run", async () => {
    const { auth, store, advance } = await setup();
    for (let i = 0; i < 3; i += 1) await auth.login("superadmin", PASSWORD, IP);
    advance(7 * DAY);
    const fresh = await auth.login("superadmin", PASSWORD, IP);

    expect(await auth.purgeExpired(2)).toBe(2);
    expect(await auth.purgeExpired(2)).toBe(1);
    expect(await auth.purgeExpired(2)).toBe(0);

    expect(store.dump().sessions.map((session) => session.tokenHash)).toEqual([hashSessionToken(fresh.token)]);
  });
});
