import { isSessionToken } from "../domain/session-token.js";

export const SESSION_COOKIE_NAME = "lessfomo_session";

/** HttpOnly (no script can read it), SameSite=Lax (not sent on cross-site POSTs), for the whole site (decision D2). */
const ATTRIBUTES = "Path=/; HttpOnly; SameSite=Lax";

const withSecure = (cookie: string, secure: boolean): string => (secure ? `${cookie}; Secure` : cookie);

/** The `Set-Cookie` value that stores a session token in the browser. */
export const buildSessionCookie = (token: string, options: { readonly maxAgeSeconds: number; readonly secure: boolean }): string =>
  withSecure(`${SESSION_COOKIE_NAME}=${token}; ${ATTRIBUTES}; Max-Age=${options.maxAgeSeconds}`, options.secure);

/** The `Set-Cookie` value that removes the session cookie. */
export const clearSessionCookie = (options: { readonly secure: boolean }): string =>
  withSecure(`${SESSION_COOKIE_NAME}=; ${ATTRIBUTES}; Max-Age=0`, options.secure);

/**
 * The session token of a `Cookie` header, strictly: the cookie must appear exactly once, be named
 * exactly `lessfomo_session` and hold a well-formed token (no quotes, no encoding). A duplicated
 * cookie is ambiguous (another path or subdomain may have planted one) and reads as none.
 */
export const parseSessionCookie = (header: string | undefined): string | null => {
  if (header === undefined) return null;
  let token: string | null = null;
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator === -1 || pair.slice(0, separator).trimStart() !== SESSION_COOKIE_NAME) continue;
    if (token !== null) return null;
    token = pair.slice(separator + 1).trimEnd();
    if (!isSessionToken(token)) return null;
  }
  return token;
};
