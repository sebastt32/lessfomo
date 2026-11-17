import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterEach, describe, expect, it } from "vitest";
import { ApiModule } from "../api/api.module.js";
import { API_ERROR_REPORTER } from "../api/http/api-exception.filter.js";
import { API_APPLICATION_OPTIONS, createApiHttpAdapter } from "../api/http/api-http-adapter.js";
import { LiveStreams } from "../api/live-streams.js";
import { loadAppConfig, type Environment } from "../config/app-config.js";
import { ConfigModule } from "../config/config.module.js";
import { HISTORY_STORE } from "../history/history.module.js";
import { SqliteHistoryRecorder } from "../history/infrastructure/sqlite/sqlite-history-recorder.js";
import { LiveFeed } from "../live-feed/application/live-feed.js";
import { LIVE_FEED } from "../live-feed/live-feed.module.js";
import { SOL_USD_PRICE } from "../market-price/market-price.module.js";
import { AUTH_CLOCK } from "./auth.module.js";
import { hashPassword, verifyPassword } from "./domain/password-hash.js";
import { hashSessionToken } from "./domain/session-token.js";

const MINT = "E3rpattxgipu5MoxktjsXHwEaYVfmowta9tnCp6bpump";
const PASSWORD = "first-password-123";
const NEW_PASSWORD = "second-password-456";
const CHEAP = { N: 1024, r: 8, p: 1 };
const DAY = 24 * 60 * 60_000;
const JSON_HEADERS = { "content-type": "application/json" };
const UNAUTHENTICATED = { error: { code: "UNAUTHENTICATED", message: "Sign in required" } };

let app: INestApplication | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

/** The API over a real (in-memory SQLite) history with one super admin, and a clock the test moves. */
const start = async (options: { env?: Environment; heartbeatMs?: number } = {}) => {
  let now = Date.now();
  const loaded = loadAppConfig({ PUBLIC_MIN_CONVICTION_WALLETS: "1", ...options.env }, new Date(now));
  const config = { ...loaded, api: { ...loaded.api, heartbeatMs: options.heartbeatMs ?? loaded.api.heartbeatMs } };
  const history = new SqliteHistoryRecorder(":memory:");
  await history.createUser({
    id: "u1",
    username: "superadmin",
    passwordHash: await hashPassword(PASSWORD, CHEAP),
    role: "superadmin",
    createdAt: new Date(now),
  });
  const reported: unknown[] = [];
  const moduleRef = await Test.createTestingModule({ imports: [ConfigModule.forRoot(config), ApiModule] })
    .overrideProvider(LIVE_FEED)
    .useValue(new LiveFeed(1))
    .overrideProvider(HISTORY_STORE)
    .useValue({ history, description: "sqlite" })
    .overrideProvider(SOL_USD_PRICE)
    .useValue({ current: () => null, subscribe: () => () => undefined })
    .overrideProvider(API_ERROR_REPORTER)
    .useValue((error: unknown) => reported.push(error))
    .overrideProvider(AUTH_CLOCK)
    .useValue(() => new Date(now))
    .compile();
  app = moduleRef.createNestApplication(createApiHttpAdapter(), API_APPLICATION_OPTIONS);
  await app.listen(0, "127.0.0.1");
  const { port } = app.getHttpServer().address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { ...JSON_HEADERS, ...headers },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
  const login = (password = PASSWORD, headers: Record<string, string> = {}, username = "superadmin") =>
    post("/api/auth/login", { username, password }, headers);
  /** Signs in and returns the `Cookie` header of the new session. */
  const signIn = async (password = PASSWORD): Promise<string> => {
    const response = await login(password);
    expect(response.status).toBe(200);
    return sessionCookieOf(response);
  };
  const get = (path: string, cookie?: string) => fetch(`${base}${path}`, cookie === undefined ? {} : { headers: { cookie } });

  return {
    base,
    history,
    reported,
    post,
    login,
    signIn,
    get,
    advance: (ms: number) => void (now += ms),
    now: () => now,
    streams: () => app!.get(LiveStreams).count(),
  };
};

const setCookieOf = (response: Response): string => {
  const cookies = response.headers.getSetCookie();
  expect(cookies).toHaveLength(1);
  return cookies[0]!;
};

const sessionCookieOf = (response: Response): string => {
  const pair = setCookieOf(response).split(";")[0]!;
  expect(pair).toMatch(/^lessfomo_session=[A-Za-z0-9_-]{43}$/);
  return pair;
};

const tokenOf = (cookie: string): string => cookie.slice("lessfomo_session=".length);

/** Resolves true once the server ends the stream, false if it is still open after `timeoutMs`. */
const endsWithin = async (reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs = 2_000): Promise<boolean> => {
  const ended = (async () => {
    while (!(await reader.read()).done);
    return true;
  })();
  const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs));
  return Promise.race([ended, timeout]);
};

const openStream = async (base: string, path: string, cookie: string) => {
  const response = await fetch(`${base}${path}`, { headers: { cookie } });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  const reader = response.body!.getReader();
  await reader.read();
  return reader;
};

const rawRequest = (base: string, head: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const { port } = new URL(base);
    const socket = connect(Number(port), "127.0.0.1", () => socket.write(`${head}\r\nHost: localhost\r\nConnection: close\r\n\r\n`));
    let raw = "";
    socket.on("data", (chunk) => (raw += chunk.toString()));
    socket.on("end", () => resolve(raw));
    socket.on("error", reject);
  });

/** Every route of docs/API.md, plus invalid and unknown ones: the guard runs before validation and routing. */
const PROTECTED: readonly (readonly [method: string, path: string])[] = [
  ["GET", "/api/movers"],
  ["GET", "/api/movers?limit=abc&minConvictionWallets=x"],
  ["GET", "/api/screenings"],
  ["GET", "/api/screenings?minSmartWallets=1.5"],
  ["GET", "/api/tokens"],
  ["GET", "/api/tokens?page=0&sort=nope"],
  ["GET", "/api/tokens/"],
  ["GET", `/api/tokens/${MINT}`],
  ["GET", `/api/tokens/${MINT}/candles`],
  ["GET", `/api/tokens/${MINT}/candles?interval=7m`],
  ["GET", `/api/tokens/${MINT}/snapshots`],
  ["GET", `/api/tokens/${MINT}/smart-wallets`],
  ["GET", `/api/tokens/${MINT}/stream`],
  ["GET", `/api/tokens/${MINT}/other`],
  ["GET", "/api/tokens/11111111111111111111111111111111"],
  ["GET", "/api/tokens/not-a-mint!"],
  ["GET", "/api/tokens/not-a-mint!/stream"],
  ["GET", "/api/tokens/%ZZ"],
  ["GET", "/api/tokens/%/candles"],
  ["GET", `/api/wallets/${MINT}`],
  ["GET", "/api/wallets/not-an-address!"],
  ["GET", "/api/analysis/smart-wallets"],
  ["GET", "/api/analysis/smart-wallets?from=yesterday&by=nope"],
  ["GET", "/api/stats"],
  ["GET", "/api/stream"],
  ["GET", "/api/auth/me"],
  ["GET", "/api/auth/login"],
  ["GET", "/api/nope"],
  ["GET", "/api/%ZZ"],
  ["GET", "/api"],
  ["GET", "/api/"],
  ["GET", "/api/health/"],
  ["GET", "/api/Health"],
  ["GET", "/api/health/x"],
  ["GET", "/api/health%2F"],
  ["GET", "/"],
  ["GET", "/nope"],
  ["POST", "/api/auth/password"],
  ["POST", "/api/auth/nope"],
  ["POST", "/api/auth/login/"],
  ["POST", "/api/health"],
  ["POST", "/api/movers"],
  ["PUT", "/api/auth/login"],
  ["DELETE", "/api/tokens"],
  ["PATCH", "/api/stream"],
];

describe("authentication (Nest e2e)", () => {
  describe("guard", () => {
    it.each(PROTECTED)("answers 401 UNAUTHENTICATED for %s %s without a session", async (method, path) => {
      const { base, reported, streams } = await start();

      const response = await fetch(`${base}${path}`, {
        method,
        headers: method === "GET" ? {} : JSON_HEADERS,
        ...(method === "GET" ? {} : { body: JSON.stringify({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }) }),
      });

      expect(response.status).toBe(401);
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(await response.json()).toEqual(UNAUTHENTICATED);
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(streams()).toBe(0);
      expect(reported).toEqual([]);
    });

    it("answers 401 for HEAD and for a request target that is not a valid URL", async () => {
      const { base } = await start();

      const head = await fetch(`${base}/api/health`, { method: "HEAD" });
      const raw = await rawRequest(base, "GET http://[::1 HTTP/1.1");

      expect(head.status).toBe(401);
      expect(raw.split("\r\n")[0]).toBe("HTTP/1.1 401 Unauthorized");
      expect(raw).toContain('"code":"UNAUTHENTICATED"');
    });

    it("keeps GET /api/health and every CORS preflight public", async () => {
      const { base, get } = await start();

      const health = await get("/api/health");
      const healthQuery = await get("/api/health?x=1");
      const dotSegments = await rawRequest(base, "GET /api/x/../health HTTP/1.1");

      expect(health.status).toBe(200);
      expect((await health.json()).status).toBe("ok");
      expect(healthQuery.status).toBe(200);
      expect(dotSegments.split("\r\n")[0]).toBe("HTTP/1.1 200 OK");
      for (const path of ["/api/movers", "/api/stream", "/api/auth/password", "/api/nope"]) {
        const preflight = await fetch(`${base}${path}`, { method: "OPTIONS", headers: { origin: "http://localhost:5173" } });
        expect([path, preflight.status]).toEqual([path, 204]);
      }
    });

    it.each([
      ["a made-up token", `lessfomo_session=${"A".repeat(43)}`],
      ["a malformed token", "lessfomo_session=abc"],
      ["a token hash instead of the token", `lessfomo_session=${"a".repeat(64)}`],
      ["another cookie name", `session=${"A".repeat(43)}`],
      ["an empty cookie", "lessfomo_session="],
    ])("answers 401 for %s", async (_name, cookie) => {
      const { get } = await start();

      for (const path of ["/api/movers", "/api/stream", `/api/tokens/${MINT}/stream`, "/api/auth/me"]) {
        const response = await get(path, cookie);
        expect([path, response.status]).toEqual([path, 401]);
        expect(await response.json()).toEqual(UNAUTHENTICATED);
      }
    });

    it("answers 401 for a session sent twice (ambiguous cookie)", async () => {
      const { get, signIn } = await start();
      const cookie = await signIn();

      expect((await get("/api/stats", `${cookie}; ${cookie}`)).status).toBe(401);
      expect((await get("/api/stats", cookie)).status).toBe(200);
    });

    it("fails closed: 401, never access, when the session cannot be checked", async () => {
      const { get, signIn, history, reported } = await start();
      const cookie = await signIn();
      history.findSession = async () => {
        throw new Error("disk on fire");
      };

      for (const path of ["/api/stats", "/api/stream", "/api/auth/me", "/api/nope"]) {
        const response = await get(path, cookie);
        expect([path, response.status]).toEqual([path, 401]);
        expect(await response.json()).toEqual(UNAUTHENTICATED);
      }
      expect((await get("/api/health")).status).toBe(200);
      // The failure is reported to the operator, never to the client, and never with the token.
      expect(reported.length).toBeGreaterThan(0);
      expect(JSON.stringify(reported.map(String))).not.toContain(tokenOf(cookie));
    });

    it("lets a signed-in session reach every route, validation and 404 included, exactly as before", async () => {
      const { get, signIn, base } = await start();
      const cookie = await signIn();
      const status = async (path: string, method = "GET") =>
        (await fetch(`${base}${path}`, { method, headers: { cookie } })).status;

      expect(await status("/api/movers")).toBe(200);
      expect(await (await get("/api/movers", cookie)).json()).toEqual({ at: null, movers: [] });
      expect(await status("/api/screenings")).toBe(200);
      expect(await status("/api/tokens")).toBe(200);
      expect(await status("/api/stats")).toBe(200);
      expect(await status("/api/analysis/smart-wallets")).toBe(200);
      expect(await status(`/api/tokens/${MINT}`)).toBe(404);
      expect(await status("/api/tokens/not-a-mint!")).toBe(400);
      expect(await status("/api/tokens?page=0")).toBe(400);
      expect(await status("/api/nope")).toBe(404);
      expect(await status("/api/movers", "POST")).toBe(405);
      expect(await status("/api/health", "HEAD")).toBe(405);
      expect(await status("/api/auth/login", "PUT")).toBe(405);
      expect(await status("/api/auth/login")).toBe(404);
      const raw = await rawRequest(base, `GET http://[::1 HTTP/1.1\r\nCookie: ${cookie}`);
      expect(raw.split("\r\n")[0]).toBe("HTTP/1.1 400 Bad Request");
    });
  });

  describe("POST /api/auth/login", () => {
    it("signs in, answers the user and sets the session cookie; only the token hash is stored", async () => {
      const { login, history } = await start();

      const response = await login();

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(setCookieOf(response)).toMatch(/^lessfomo_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=604800$/);
      const token = tokenOf(sessionCookieOf(response));
      expect(await response.json()).toEqual({ user: { username: "superadmin", role: "superadmin" } });
      expect(history.query("SELECT token_hash FROM sessions")).toEqual([{ token_hash: hashSessionToken(token) }]);
      expect(JSON.stringify(history.query("SELECT * FROM sessions"))).not.toContain(token);
    });

    it("accepts the username in any case", async () => {
      const { login } = await start();

      const response = await login(PASSWORD, {}, "SuperAdmin");

      expect(response.status).toBe(200);
      expect((await response.json()).user.username).toBe("superadmin");
    });

    it("marks the cookie Secure over HTTPS (X-Forwarded-Proto) or when AUTH_COOKIE_SECURE=true", async () => {
      const plain = await start();
      expect(setCookieOf(await plain.login(PASSWORD, { "x-forwarded-proto": "https" }))).toMatch(/; Max-Age=604800; Secure$/);
      expect(setCookieOf(await plain.login(PASSWORD, { "x-forwarded-proto": "http" }))).not.toContain("Secure");
      expect(setCookieOf(await plain.login(PASSWORD, { "x-forwarded-ssl": "on", forwarded: "proto=https" }))).not.toContain("Secure");
      await app!.close();

      const forced = await start({ env: { AUTH_COOKIE_SECURE: "true" } });
      expect(setCookieOf(await forced.login())).toMatch(/; Secure$/);
    });

    it("uses AUTH_SESSION_DAYS for the cookie and the session lifetime", async () => {
      const { login, history, now } = await start({ env: { AUTH_SESSION_DAYS: "2" } });

      const response = await login();

      expect(setCookieOf(response)).toContain("; Max-Age=172800");
      expect(history.query("SELECT expires_at FROM sessions")).toEqual([{ expires_at: now() + 2 * DAY }]);
    });

    it("answers the same 401 INVALID_CREDENTIALS for an unknown user and a wrong password, without a cookie", async () => {
      const { login, history } = await start();

      const wrong = await login("wrong-password-123");
      const unknown = await login(PASSWORD, {}, "nobody");

      expect([wrong.status, unknown.status]).toEqual([401, 401]);
      expect(await wrong.json()).toEqual(await unknown.json());
      expect(wrong.headers.getSetCookie()).toEqual([]);
      expect(unknown.headers.getSetCookie()).toEqual([]);
      expect(history.query("SELECT * FROM sessions")).toEqual([]);
      expect((await (await login("wrong-password-123")).json()).error).toEqual({
        code: "INVALID_CREDENTIALS",
        message: "Invalid username or password",
      });
    });

    it.each([
      ["no body", undefined],
      ["an empty body", ""],
      ["malformed JSON", '{"username":"superadmin",'],
      ["a JSON array", ["superadmin", PASSWORD]],
      ["a JSON string", '"superadmin"'],
      ["JSON null", "null"],
      ["a missing password", { username: "superadmin" }],
      ["a missing username", { password: PASSWORD }],
      ["a non-string username", { username: 1, password: PASSWORD }],
      ["a non-string password", { username: "superadmin", password: ["x"] }],
      ["an empty username", { username: "", password: PASSWORD }],
      ["an empty password", { username: "superadmin", password: "" }],
      ["a username over 64 characters", { username: "a".repeat(65), password: PASSWORD }],
      ["a password over 1024 characters", { username: "superadmin", password: "a".repeat(1025) }],
      ["a body over 4 kB", { username: "superadmin", password: PASSWORD, padding: "x".repeat(4096) }],
    ])("answers 400 INVALID_BODY for %s", async (_name, body) => {
      const { post, history } = await start();

      const response = await post("/api/auth/login", body);

      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("INVALID_BODY");
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(history.query("SELECT * FROM sessions")).toEqual([]);
    });

    it("answers 400 INVALID_BODY unless the content type is application/json", async () => {
      const { base } = await start();
      const body = JSON.stringify({ username: "superadmin", password: PASSWORD });

      for (const headers of [{}, { "content-type": "text/plain" }, { "content-type": "application/x-www-form-urlencoded" }]) {
        const response = await fetch(`${base}/api/auth/login`, { method: "POST", headers, body });
        expect(response.status).toBe(400);
        expect((await response.json()).error.code).toBe("INVALID_BODY");
      }
      const charset = await fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "Application/JSON; charset=utf-8" },
        body,
      });
      expect(charset.status).toBe(200);
    });

    it("answers 429 TOO_MANY_ATTEMPTS with Retry-After after 5 failures of a username and client IP in 15 minutes", async () => {
      const { login, advance } = await start();
      const from = (ip: string) => ({ "x-forwarded-for": `${ip}, 10.0.0.1` });

      for (let i = 0; i < 5; i += 1) expect((await login("wrong-password-123", from("203.0.113.7"))).status).toBe(401);
      advance(60_000);
      const blocked = await login(PASSWORD, from("203.0.113.7"));

      expect(blocked.status).toBe(429);
      expect(blocked.headers.get("retry-after")).toBe("840");
      expect(blocked.headers.getSetCookie()).toEqual([]);
      expect((await blocked.json()).error.code).toBe("TOO_MANY_ATTEMPTS");
      // A cross-origin dashboard can read how long to wait.
      const crossOrigin = await login(PASSWORD, { ...from("203.0.113.7"), origin: "http://localhost:5173" });
      expect(crossOrigin.status).toBe(429);
      expect(crossOrigin.headers.get("retry-after")).toBe("840");
      expect(crossOrigin.headers.get("access-control-expose-headers")).toBe("Retry-After");
      // Another client IP and another username are counted apart; the block ends with the window.
      expect((await login(PASSWORD, from("198.51.100.1"))).status).toBe(200);
      expect((await login(PASSWORD, from("203.0.113.7"), "nobody")).status).toBe(401);
      advance(14 * 60_000);
      expect((await login(PASSWORD, from("203.0.113.7"))).status).toBe(200);
    });

    it("forgets failed attempts after a successful sign-in", async () => {
      const { login } = await start();
      for (let i = 0; i < 4; i += 1) await login("wrong-password-123");

      expect((await login()).status).toBe(200);

      for (let i = 0; i < 5; i += 1) expect((await login("wrong-password-123")).status).toBe(401);
      expect((await login()).status).toBe(429);
    });

    it("answers 429 TOO_MANY_ATTEMPTS after 30 failures of a client IP across usernames, whatever the username", async () => {
      const { login } = await start();
      const from = (ip: string) => ({ "x-forwarded-for": ip });

      // Four at a time: no more than the password verifications that run at once.
      for (let batch = 0; batch < 30; batch += 5) {
        const answers = await Promise.all(
          [0, 1, 2, 3, 4].map((offset) => login("wrong-password-123", from("203.0.113.7"), `nobody${batch + offset}`)),
        );
        expect(answers.map((answer) => answer.status)).toEqual([401, 401, 401, 401, 401]);
      }
      const blocked = await login(PASSWORD, from("203.0.113.7"));

      expect(blocked.status).toBe(429);
      expect((await blocked.json()).error.code).toBe("TOO_MANY_ATTEMPTS");
      expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(blocked.headers.getSetCookie()).toEqual([]);
      expect((await login(PASSWORD, from("198.51.100.1"))).status).toBe(200);
    }, 30_000);

    it("answers 503 SERVER_BUSY with Retry-After: 2 instead of queueing password checks without bound", async () => {
      const { login, post, signIn } = await start();
      const cookie = await signIn();

      // Unknown usernames cost a full scrypt verification each: 4 run, 32 wait, the rest are refused at once.
      const flood = await Promise.all(
        Array.from({ length: 80 }, (_, i) => login("wrong-password-123", { "x-forwarded-for": `10.9.${i}.1` }, `nobody${i}`)),
      );

      const busy = flood.filter((answer) => answer.status === 503);
      expect(flood.filter((answer) => answer.status !== 503 && answer.status !== 401)).toEqual([]);
      expect(flood.filter((answer) => answer.status === 401).length).toBeLessThanOrEqual(36);
      expect(busy.length).toBeGreaterThanOrEqual(44);
      for (const answer of busy) {
        expect(answer.headers.get("retry-after")).toBe("2");
        expect(answer.headers.getSetCookie()).toEqual([]);
        expect((await answer.json()).error.code).toBe("SERVER_BUSY");
      }
      // Served again once the queue drained; the busy answers did not lock anybody out.
      expect((await login()).status).toBe(200);
      expect((await post("/api/auth/password", { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, { cookie })).status).toBe(204);
    }, 30_000);
  });

  describe("CSRF defence and CORS", () => {
    it("answers 403 FORBIDDEN_ORIGIN for a state-changing request from another origin", async () => {
      const { login, post, signIn, get } = await start();
      const cookie = await signIn();

      for (const origin of ["https://evil.example", "null", "http://localhost:5174"]) {
        const response = await login(PASSWORD, { origin });
        expect([origin, response.status]).toEqual([origin, 403]);
        expect((await response.json()).error.code).toBe("FORBIDDEN_ORIGIN");
        expect(response.headers.getSetCookie()).toEqual([]);
      }
      const logout = await post("/api/auth/logout", undefined, { origin: "https://evil.example", cookie });
      const password = await post(
        "/api/auth/password",
        { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
        { origin: "https://evil.example", cookie },
      );

      expect([logout.status, password.status]).toEqual([403, 403]);
      expect((await get("/api/auth/me", cookie)).status).toBe(200);
    });

    it("accepts the API's own origin, an allowed CORS origin and no Origin at all", async () => {
      const { login, base } = await start();

      expect((await login(PASSWORD, { origin: base })).status).toBe(200);
      expect((await login(PASSWORD, { origin: "http://localhost:5173" })).status).toBe(200);
      expect((await login()).status).toBe(200);
    });

    it("allows credentials for allowed origins only, and the auth POSTs in their preflights", async () => {
      const { base, login } = await start();
      const allowed = { origin: "http://localhost:5173" };

      const signedIn = await login(PASSWORD, allowed);
      const health = await fetch(`${base}/api/health`, { headers: allowed });
      const denied = await fetch(`${base}/api/health`, { headers: { origin: "https://evil.example" } });
      const unauthenticated = await fetch(`${base}/api/movers`, { headers: allowed });
      const preflight = await fetch(`${base}/api/auth/login`, {
        method: "OPTIONS",
        headers: { ...allowed, "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
      });
      const deniedPreflight = await fetch(`${base}/api/auth/login`, { method: "OPTIONS", headers: { origin: "https://evil.example" } });
      const readPreflight = await fetch(`${base}/api/movers`, { method: "OPTIONS", headers: allowed });

      for (const response of [signedIn, health, unauthenticated, preflight, readPreflight]) {
        expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
        expect(response.headers.get("access-control-allow-credentials")).toBe("true");
        expect(response.headers.get("access-control-expose-headers")).toBe("Retry-After");
        expect(response.headers.get("vary")).toBe("Origin");
      }
      expect(unauthenticated.status).toBe(401);
      expect(denied.headers.get("access-control-allow-origin")).toBeNull();
      expect(denied.headers.get("access-control-allow-credentials")).toBeNull();
      expect(denied.headers.get("access-control-expose-headers")).toBeNull();
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-methods")).toBe("GET, POST, OPTIONS");
      expect(preflight.headers.get("access-control-allow-headers")).toBe("Content-Type");
      expect(preflight.headers.get("access-control-max-age")).toBe("600");
      expect(deniedPreflight.headers.get("access-control-allow-origin")).toBeNull();
      expect(deniedPreflight.headers.get("access-control-allow-credentials")).toBeNull();
      expect(readPreflight.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
      expect(readPreflight.headers.get("access-control-allow-headers")).toBeNull();
    });
  });

  describe("GET /api/auth/me", () => {
    it("answers the signed-in user", async () => {
      const { get, signIn } = await start();

      const response = await get("/api/auth/me", await signIn());

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ user: { username: "superadmin", role: "superadmin" } });
    });
  });

  describe("session lifetime", () => {
    it("slides the expiry and refreshes the cookie at most once per minute", async () => {
      const { get, signIn, history, advance, now } = await start();
      const cookie = await signIn();
      const signedInAt = now();
      const stored = () => history.query("SELECT created_at, last_seen_at, expires_at FROM sessions")[0];

      advance(59_000);
      const early = await get("/api/stats", cookie);
      expect(early.status).toBe(200);
      expect(early.headers.getSetCookie()).toEqual([]);
      expect(stored()).toEqual({ created_at: signedInAt, last_seen_at: signedInAt, expires_at: signedInAt + 7 * DAY });

      advance(1_000);
      const refreshed = await get("/api/stats", cookie);
      expect(refreshed.status).toBe(200);
      expect(setCookieOf(refreshed)).toBe(`${cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`);
      expect(stored()).toEqual({ created_at: signedInAt, last_seen_at: now(), expires_at: now() + 7 * DAY });
      expect((await get("/api/stats", cookie)).headers.getSetCookie()).toEqual([]);
    });

    it("rejects a session 7 days after its last request, not before", async () => {
      const { get, signIn, advance } = await start();
      const cookie = await signIn();

      advance(6 * DAY);
      expect((await get("/api/stats", cookie)).status).toBe(200);
      advance(7 * DAY - 1);
      expect((await get("/api/stats", cookie)).status).toBe(200);
      advance(7 * DAY);
      const expired = await get("/api/stats", cookie);

      expect(expired.status).toBe(401);
      expect(await expired.json()).toEqual(UNAUTHENTICATED);
      expect((await get("/api/auth/me", cookie)).status).toBe(401);
      expect((await get("/api/stream", cookie)).status).toBe(401);
    });

    it("rejects a session deleted from the store", async () => {
      const { get, signIn, history } = await start();
      const cookie = await signIn();

      await history.deleteSession(hashSessionToken(tokenOf(cookie)));

      expect((await get("/api/stats", cookie)).status).toBe(401);
      expect((await get(`/api/tokens/${MINT}/stream`, cookie)).status).toBe(401);
    });
  });

  describe("POST /api/auth/logout", () => {
    it("deletes the session, clears the cookie and answers 204", async () => {
      const { post, get, signIn, history } = await start();
      const cookie = await signIn();
      const other = await signIn();

      const response = await post("/api/auth/logout", undefined, { cookie, "x-forwarded-proto": "https" });

      expect(response.status).toBe(204);
      expect(await response.text()).toBe("");
      expect(setCookieOf(response)).toBe("lessfomo_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure");
      expect((await get("/api/auth/me", cookie)).status).toBe(401);
      expect((await get("/api/stats", cookie)).status).toBe(401);
      expect((await get("/api/auth/me", other)).status).toBe(200);
      expect(history.query("SELECT token_hash FROM sessions")).toEqual([{ token_hash: hashSessionToken(tokenOf(other)) }]);
    });

    it("also answers 204 without a session, or with an unknown or expired one", async () => {
      const { post, signIn, advance } = await start();
      const expired = await signIn();
      advance(8 * DAY);

      for (const headers of [{}, { cookie: `lessfomo_session=${"A".repeat(43)}` }, { cookie: "lessfomo_session=abc" }, { cookie: expired }]) {
        const response = await post("/api/auth/logout", undefined, headers);
        expect(response.status).toBe(204);
        expect(setCookieOf(response)).toBe("lessfomo_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
      }
    });

    it("closes the session's streams, and only those", async () => {
      const { base, post, signIn, streams } = await start();
      const cookie = await signIn();
      const other = await signIn();
      const feed = await openStream(base, "/api/stream", cookie);
      const tokenStream = await openStream(base, `/api/tokens/${MINT}/stream`, cookie);
      const otherFeed = await openStream(base, "/api/stream", other);
      expect(streams()).toBe(3);

      await post("/api/auth/logout", undefined, { cookie });

      expect(await endsWithin(feed)).toBe(true);
      expect(await endsWithin(tokenStream)).toBe(true);
      expect(streams()).toBe(1);
      expect(await endsWithin(otherFeed, 100)).toBe(false);
    });
  });

  describe("POST /api/auth/password", () => {
    const change = (currentPassword: string, newPassword: string) => ({ currentPassword, newPassword });

    it("changes the password, keeps this session and deletes the user's other sessions, closing their streams", async () => {
      const { base, post, get, signIn, login, history, streams } = await start();
      const cookie = await signIn();
      const other = await signIn();
      const ownStream = await openStream(base, "/api/stream", cookie);
      const otherStream = await openStream(base, "/api/stream", other);
      const otherTokenStream = await openStream(base, `/api/tokens/${MINT}/stream`, other);

      const response = await post("/api/auth/password", change(PASSWORD, NEW_PASSWORD), { cookie });

      expect(response.status).toBe(204);
      expect(await response.text()).toBe("");
      expect((await get("/api/auth/me", cookie)).status).toBe(200);
      expect((await get("/api/auth/me", other)).status).toBe(401);
      expect((await get("/api/stats", other)).status).toBe(401);
      expect(await endsWithin(otherStream)).toBe(true);
      expect(await endsWithin(otherTokenStream)).toBe(true);
      expect(streams()).toBe(1);
      expect(await endsWithin(ownStream, 100)).toBe(false);
      expect((await login(PASSWORD)).status).toBe(401);
      expect((await login(NEW_PASSWORD)).status).toBe(200);
      const [user] = history.query("SELECT password_hash FROM users");
      expect(String(user?.["password_hash"])).toMatch(/^scrypt\$32768\$8\$3\$/);
      expect(await verifyPassword(NEW_PASSWORD, String(user?.["password_hash"]))).toBe(true);
    });

    it("answers 401 INVALID_CREDENTIALS for a wrong current password, changing nothing", async () => {
      const { post, get, signIn, login } = await start();
      const cookie = await signIn();
      const other = await signIn();

      const response = await post("/api/auth/password", change("wrong-password-123", NEW_PASSWORD), { cookie });

      expect(response.status).toBe(401);
      expect((await response.json()).error.code).toBe("INVALID_CREDENTIALS");
      expect((await get("/api/auth/me", cookie)).status).toBe(200);
      expect((await get("/api/auth/me", other)).status).toBe(200);
      expect((await login(NEW_PASSWORD)).status).toBe(401);
      expect((await login(PASSWORD)).status).toBe(200);
    });

    it("answers 400 WEAK_PASSWORD for a new password under 12 characters or equal to the current one", async () => {
      const { post, signIn, login } = await start();
      const cookie = await signIn();

      for (const newPassword of ["short-11chr", PASSWORD]) {
        const response = await post("/api/auth/password", change(PASSWORD, newPassword), { cookie });
        expect(response.status).toBe(400);
        expect((await response.json()).error.code).toBe("WEAK_PASSWORD");
      }
      expect((await login(PASSWORD)).status).toBe(200);
    });

    it("answers 400 INVALID_BODY for a malformed body", async () => {
      const { post, signIn } = await start();
      const cookie = await signIn();

      for (const body of [undefined, "{", { currentPassword: PASSWORD }, { newPassword: NEW_PASSWORD }, change(PASSWORD, "a".repeat(1025)), [1]]) {
        const response = await post("/api/auth/password", body, { cookie });
        expect(response.status).toBe(400);
        expect((await response.json()).error.code).toBe("INVALID_BODY");
      }
    });

    it("limits wrong current passwords like failed sign-ins", async () => {
      const { post, signIn } = await start();
      const cookie = await signIn();

      for (let i = 0; i < 5; i += 1) {
        expect((await post("/api/auth/password", change("wrong-password-123", NEW_PASSWORD), { cookie })).status).toBe(401);
      }
      const blocked = await post("/api/auth/password", change(PASSWORD, NEW_PASSWORD), { cookie });

      expect(blocked.status).toBe(429);
      expect(blocked.headers.get("retry-after")).toBe("900");
      expect((await blocked.json()).error.code).toBe("TOO_MANY_ATTEMPTS");
    });
  });

  describe("streams of a session that ends", () => {
    it("closes a stream on the next heartbeat once its session expired", async () => {
      const { base, signIn, advance, streams } = await start({ heartbeatMs: 10 });
      const cookie = await signIn();
      const feed = await openStream(base, "/api/stream", cookie);
      const tokenStream = await openStream(base, `/api/tokens/${MINT}/stream`, cookie);
      expect(await endsWithin(feed, 60)).toBe(false);

      advance(7 * DAY);

      expect(await endsWithin(feed)).toBe(true);
      expect(await endsWithin(tokenStream)).toBe(true);
      expect(streams()).toBe(0);
    });

    it("closes a stream on the next heartbeat once its session was deleted elsewhere (create-superadmin --reset)", async () => {
      const { base, signIn, history, streams } = await start({ heartbeatMs: 10 });
      const cookie = await signIn();
      const feed = await openStream(base, "/api/stream", cookie);

      await history.deleteUserSessions("u1", null);

      expect(await endsWithin(feed)).toBe(true);
      expect(streams()).toBe(0);
    });

    it("closes a stream when its session can no longer be checked", async () => {
      const { base, signIn, history, streams } = await start({ heartbeatMs: 10 });
      const feed = await openStream(base, "/api/stream", await signIn());

      history.findSession = async () => {
        throw new Error("disk on fire");
      };

      expect(await endsWithin(feed)).toBe(true);
      expect(streams()).toBe(0);
    });
  });

  it("never reports or logs passwords, tokens, cookies or hashes", async () => {
    const lines: string[] = [];
    const original = { log: console.log, error: console.error, warn: console.warn };
    console.log = console.error = console.warn = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
    try {
      const { login, post, get, signIn, reported, history } = await start();
      const cookie = await signIn();
      await login("wrong-password-123");
      await post("/api/auth/login", "{");
      await get("/api/stats", `lessfomo_session=${"A".repeat(43)}`);
      await post("/api/auth/password", { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, { cookie });
      await post("/api/auth/logout", undefined, { cookie });
      const [user] = history.query("SELECT password_hash FROM users");

      const output = JSON.stringify([lines, reported.map(String)]);
      for (const secret of [PASSWORD, NEW_PASSWORD, "wrong-password-123", tokenOf(cookie), hashSessionToken(tokenOf(cookie)), String(user?.["password_hash"])]) {
        expect(output).not.toContain(secret);
      }
    } finally {
      Object.assign(console, original);
    }
  });
});
