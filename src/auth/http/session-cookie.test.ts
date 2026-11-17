import { describe, expect, it } from "vitest";
import { newSessionToken } from "../domain/session-token.js";
import { buildSessionCookie, clearSessionCookie, parseSessionCookie, SESSION_COOKIE_NAME } from "./session-cookie.js";

const TOKEN = newSessionToken().token;

describe("session cookie", () => {
  it("is HttpOnly, SameSite=Lax, Path=/ with a Max-Age, and Secure only when asked", () => {
    expect(SESSION_COOKIE_NAME).toBe("lessfomo_session");
    expect(buildSessionCookie(TOKEN, { maxAgeSeconds: 604800, secure: false })).toBe(
      `lessfomo_session=${TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`,
    );
    expect(buildSessionCookie(TOKEN, { maxAgeSeconds: 60, secure: true })).toBe(
      `lessfomo_session=${TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=60; Secure`,
    );
  });

  it("is cleared with the same attributes and Max-Age=0", () => {
    expect(clearSessionCookie({ secure: false })).toBe("lessfomo_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
    expect(clearSessionCookie({ secure: true })).toBe("lessfomo_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure");
  });

  it("reads the session token among other cookies", () => {
    expect(parseSessionCookie(`lessfomo_session=${TOKEN}`)).toBe(TOKEN);
    expect(parseSessionCookie(`theme=dark; lessfomo_session=${TOKEN}; other=1`)).toBe(TOKEN);
    expect(parseSessionCookie(`theme=dark;lessfomo_session=${TOKEN}`)).toBe(TOKEN);
  });

  it("reads nothing from a missing, malformed, duplicated or look-alike cookie", () => {
    for (const header of [
      undefined,
      "",
      "theme=dark",
      "lessfomo_session=",
      "lessfomo_session=short",
      `lessfomo_session="${TOKEN}"`,
      `lessfomo_session=${TOKEN}x`,
      `lessfomo_session=${TOKEN.slice(0, -1)}%`,
      `lessfomo_session=${TOKEN}; lessfomo_session=${TOKEN}`,
      `lessfomo_session=${newSessionToken().token}; lessfomo_session=${TOKEN}`,
      `xlessfomo_session=${TOKEN}`,
      `lessfomo_session_x=${TOKEN}`,
      `LESSFOMO_SESSION=${TOKEN}`,
      `lessfomo_session =${TOKEN}`,
      `other=lessfomo_session=${TOKEN}`,
      `lessfomo_session=${TOKEN}, theme=dark`,
    ]) {
      expect(parseSessionCookie(header), String(header)).toBeNull();
    }
  });
});
