import { describe, expect, it } from "vitest";
import { SqliteHistoryRecorder } from "../../history/infrastructure/sqlite/sqlite-history-recorder.js";
import { AuthError } from "../domain/auth-error.js";
import { LoginThrottle } from "../domain/login-throttle.js";
import { hashPassword, verifyPasswordOrDummy, type PasswordHasher } from "../domain/password-hash.js";
import type { SessionStore } from "../domain/session-store.js";
import type { UserStore } from "../domain/user-store.js";
import { WorkGate } from "../domain/work-gate.js";
import { InMemoryAuthStore } from "../testing/in-memory-auth-store.js";
import { AuthService, type LoginResult } from "./auth-service.js";
import { provisionSuperadmin } from "./superadmin.js";

const CHEAP = { N: 1024, r: 8, p: 1 };
const PASSWORD = "first-password-123";
const NEW_PASSWORD = "second-password-456";
const DAY = 24 * 60 * 60_000;
const IP = "203.0.113.7";
const OTHER_IP = "198.51.100.1";

interface Hold {
  /** Resolves once a verification finished its work and is waiting to answer. */
  readonly reached: Promise<void>;
  release(): void;
}

/**
 * A real (cheap) scrypt hasher whose verifications can be held after they computed their answer,
 * so a test decides what happens between "the password was checked" and "the session is opened".
 */
const holdableHasher = () => {
  const holds: { reached: () => void; released: Promise<void> }[] = [];
  let verifications = 0;
  const hasher: PasswordHasher = {
    hash: (password) => hashPassword(password, CHEAP),
    verify: async (password, stored) => {
      verifications += 1;
      const hold = holds.shift();
      const matches = await verifyPasswordOrDummy(password, stored);
      if (hold !== undefined) {
        hold.reached();
        await hold.released;
      }
      return matches;
    },
  };
  const holdNextVerification = (): Hold => {
    let reached = (): void => undefined;
    let release = (): void => undefined;
    const hold = {
      reached: new Promise<void>((resolve) => (reached = resolve)),
      released: new Promise<void>((resolve) => (release = resolve)),
    };
    holds.push({ reached, released: hold.released });
    return { reached: hold.reached, release };
  };
  return { hasher, holdNextVerification, verifications: () => verifications };
};

const settled = (work: Promise<LoginResult>): Promise<LoginResult | AuthError> =>
  work.catch((error: unknown) => {
    if (error instanceof AuthError) return error;
    throw error;
  });

const STORES: Record<string, () => UserStore & SessionStore> = {
  "in-memory store": () => new InMemoryAuthStore(),
  "SQLite store": () => new SqliteHistoryRecorder(":memory:"),
};

describe.each(Object.entries(STORES))("AuthService with credentials that change during a sign-in (%s)", (_name, newStore) => {
  const setup = async (gate?: WorkGate) => {
    const clock = () => new Date("2026-11-17T10:00:00.000Z");
    const store = newStore();
    await store.createUser({ id: "u1", username: "SuperAdmin", passwordHash: await hashPassword(PASSWORD, CHEAP), role: "superadmin", createdAt: clock() });
    const passwords = holdableHasher();
    const auth = new AuthService({
      users: store,
      sessions: store,
      clock,
      sessionMs: 7 * DAY,
      throttle: new LoginThrottle(clock),
      passwords: passwords.hasher,
      ...(gate === undefined ? {} : { passwordWork: gate }),
    });
    return { auth, store, clock, ...passwords };
  };

  /** The outcome must be a refusal, and whatever token came back must not be a session. */
  const expectNoSession = async (auth: AuthService, outcome: LoginResult | AuthError): Promise<void> => {
    const token = outcome instanceof AuthError ? null : outcome.token;
    expect(token === null ? null : await auth.authenticate(token)).toBeNull();
    expect(outcome).toBeInstanceOf(AuthError);
    expect(outcome).toMatchObject({ code: "INVALID_CREDENTIALS" });
  };

  it("opens no session for a password that was verified before a password change finished", async () => {
    const { auth, holdNextVerification } = await setup();
    const current = await auth.login("superadmin", PASSWORD, IP);
    const session = (await auth.authenticate(current.token))!;

    const hold = holdNextVerification();
    const racing = settled(auth.login("superadmin", PASSWORD, OTHER_IP));
    await hold.reached;
    await auth.changePassword(session, PASSWORD, NEW_PASSWORD, IP);
    hold.release();

    await expectNoSession(auth, await racing);
    expect(await auth.authenticate(current.token)).not.toBeNull();
    expect((await auth.login("superadmin", NEW_PASSWORD, OTHER_IP)).user.username).toBe("SuperAdmin");
  });

  it("opens no session for a password that was verified before create-superadmin --reset finished", async () => {
    const { auth, store, clock, holdNextVerification } = await setup();
    const before = await auth.login("superadmin", PASSWORD, IP);

    const hold = holdNextVerification();
    const racing = settled(auth.login("superadmin", PASSWORD, OTHER_IP));
    await hold.reached;
    const reset = await provisionSuperadmin({ users: store }, "superadmin", { reset: true, now: clock() });
    hold.release();

    expect(reset.outcome).toBe("reset");
    await expectNoSession(auth, await racing);
    expect(await auth.authenticate(before.token)).toBeNull();
  });

  it("lets only one of two password changes that verified the same current password win", async () => {
    const { auth, store, holdNextVerification } = await setup();
    const first = await auth.login("superadmin", PASSWORD, IP);
    const second = await auth.login("superadmin", PASSWORD, OTHER_IP);
    const firstSession = (await auth.authenticate(first.token))!;
    const secondSession = (await auth.authenticate(second.token))!;

    const hold = holdNextVerification();
    const late = auth.changePassword(secondSession, PASSWORD, "third-password-789", OTHER_IP).then(
      () => "changed",
      (error: unknown) => (error instanceof AuthError ? error.code : "failed"),
    );
    await hold.reached;
    await auth.changePassword(firstSession, PASSWORD, NEW_PASSWORD, IP);
    hold.release();

    expect(await late).toBe("INVALID_CREDENTIALS");
    expect(await verifyPasswordOrDummy(NEW_PASSWORD, (await store.findUserById("u1"))!.passwordHash)).toBe(true);
    expect(await auth.authenticate(first.token)).not.toBeNull();
    expect(await auth.authenticate(second.token)).toBeNull();
  });

  it("answers SERVER_BUSY without hashing when the password queue is full, and does not count it as a failure", async () => {
    const { auth, holdNextVerification, verifications } = await setup(new WorkGate({ maxConcurrent: 1, maxQueued: 1 }));
    const hold = holdNextVerification();
    const running = settled(auth.login("superadmin", PASSWORD, "10.0.0.1"));
    await hold.reached;
    const queued = settled(auth.login("superadmin", PASSWORD, "10.0.0.2"));

    for (let i = 0; i < 8; i += 1) {
      const busy = await settled(auth.login("superadmin", PASSWORD, IP));
      expect(busy).toMatchObject({ code: "SERVER_BUSY", retryAfterSeconds: 2 });
    }
    expect(verifications()).toBe(1);

    hold.release();
    expect(await running).toMatchObject({ user: { username: "SuperAdmin" } });
    expect(await queued).toMatchObject({ user: { username: "SuperAdmin" } });
    expect(await settled(auth.login("superadmin", PASSWORD, IP))).toMatchObject({ user: { username: "SuperAdmin" } });
  });
});
