import type { IncomingMessage } from "node:http";
import type { AuthenticatedSession } from "../application/auth-service.js";

/** The session the guard found for each request; nothing else may put one here. */
const sessions = new WeakMap<IncomingMessage, AuthenticatedSession>();

export const attachSession = (request: IncomingMessage, session: AuthenticatedSession): void => {
  sessions.set(request, session);
};

/** The request's session, or null when the guard did not authenticate it. */
export const sessionOf = (request: IncomingMessage): AuthenticatedSession | null => sessions.get(request) ?? null;
