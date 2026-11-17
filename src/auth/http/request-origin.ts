import type { IncomingHttpHeaders } from "node:http";
import { isIP } from "node:net";

const first = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

/** The first element of a comma-separated header, trimmed. */
const firstElement = (value: string | string[] | undefined): string => (first(value) ?? "").split(",")[0]?.trim() ?? "";

/**
 * CSRF defence for state-changing requests (decision D3): a browser always sends `Origin` on a
 * cross-site POST, so when the header is present it must be an allowed CORS origin or the API's own
 * origin, i.e. the same host (and port) the request was addressed to in `Host`. A page on another
 * site cannot choose either header. Requests without `Origin` (curl, same-origin GET-style clients)
 * are not cross-site browser requests and pass.
 */
export const isAllowedOrigin = (origin: string | undefined, host: string | undefined, allowedOrigins: readonly string[]): boolean => {
  if (origin === undefined) return true;
  if (allowedOrigins.includes(origin)) return true;
  if (host === undefined || !URL.canParse(origin)) return false;
  const url = new URL(origin);
  const isWebOrigin = (url.protocol === "http:" || url.protocol === "https:") && origin.toLowerCase() === url.origin;
  return isWebOrigin && url.host === host.toLowerCase();
};

/**
 * The client address used to throttle sign-ins: the first hop of `X-Forwarded-For` when it is an
 * IP address, otherwise the socket's address.
 *
 * The header is trusted only because the API is reachable solely through the dashboard's reverse
 * proxy, which sets it. Exposed directly, a client could send any value and dodge the per-IP limit
 * (never gain access): do not publish the API port.
 */
export const clientIpOf = (headers: IncomingHttpHeaders, remoteAddress: string | undefined): string => {
  const forwarded = firstElement(headers["x-forwarded-for"]);
  return isIP(forwarded) !== 0 ? forwarded : (remoteAddress ?? "unknown");
};

/** Whether the client reached the proxy over HTTPS, from `X-Forwarded-Proto` only (decision D2). */
export const isHttpsRequest = (headers: IncomingHttpHeaders): boolean =>
  firstElement(headers["x-forwarded-proto"]).toLowerCase() === "https";
