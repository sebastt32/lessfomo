import type { IncomingMessage } from "node:http";

/** Requests whose target is not a valid URL, answered with 400 BAD_REQUEST once CORS and the method are checked. */
const invalidTargets = new WeakSet<IncomingMessage>();

/**
 * Routes every request on its WHATWG-normalized path (`new URL(target, base)`), so `/a/../b` and
 * absolute-form targets resolve as they always have. A target that is not a valid URL is routed
 * as `/` and marked instead: Express cannot parse it and would otherwise skip every handler.
 */
export const normalizeRequestTarget = (request: IncomingMessage): void => {
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    request.url = url.pathname + url.search;
  } catch {
    invalidTargets.add(request);
    request.url = "/";
  }
};

export const hasInvalidRequestTarget = (request: IncomingMessage): boolean => invalidTargets.has(request);
