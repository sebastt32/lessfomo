import type { TestingModuleBuilder } from "@nestjs/testing";
import { SESSION_STORE, USER_STORE } from "../auth.tokens.js";
import { newSessionToken } from "../domain/session-token.js";
import { SESSION_COOKIE_NAME } from "../http/session-cookie.js";
import { InMemoryAuthStore } from "./in-memory-auth-store.js";

const DAY_MS = 24 * 60 * 60_000;

/**
 * A signed-in session for tests of everything behind the sign-in: `signIn` gives a test module
 * in-memory users and sessions holding one valid session, and `fetch` sends that session's cookie,
 * so a test file exercises the API exactly as before by shadowing the global:
 *
 *     const session = createTestSession();
 *     const fetch = session.fetch;
 */
export const createTestSession = () => {
  const { token, tokenHash } = newSessionToken();
  const cookie = `${SESSION_COOKIE_NAME}=${token}`;

  const newStore = (): InMemoryAuthStore => {
    const store = new InMemoryAuthStore();
    const now = new Date();
    // Never signs in with a password: the hash matches nothing.
    void store.createUser({ id: "test-user", username: "tester", passwordHash: "!", role: "superadmin", createdAt: now });
    void store.createSession({ tokenHash, userId: "test-user", createdAt: now, lastSeenAt: now, expiresAt: new Date(now.getTime() + DAY_MS) });
    return store;
  };

  return {
    /** The `Cookie` header of the session. */
    cookie,
    /** Replaces the module's user and session stores with fresh in-memory ones holding the session. */
    signIn: (builder: TestingModuleBuilder): TestingModuleBuilder => {
      const store = newStore();
      return builder.overrideProvider(USER_STORE).useValue(store).overrideProvider(SESSION_STORE).useValue(store);
    },
    /** `fetch` with the session cookie, unless the request brings its own `Cookie` header. */
    fetch: (input: string | URL, init: RequestInit = {}): Promise<Response> => {
      const headers = new Headers(init.headers);
      if (!headers.has("cookie")) headers.set("cookie", cookie);
      return globalThis.fetch(input, { ...init, headers });
    },
  };
};
