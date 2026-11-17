import type { IncomingMessage } from "node:http";
import { ApiErrors } from "../../api/http/api-error.js";

/** Largest body read, in bytes: the auth endpoints only take two short strings. */
export const MAX_BODY_BYTES = 4096;

export type JsonObject = Readonly<Record<string, unknown>>;

/** The JSON object each auth request sent; null when it sent no body. */
const bodies = new WeakMap<IncomingMessage, JsonObject | null>();

const EXPECTED = "a JSON object of at most 4 kB";

const readBytes = (request: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    if (Number(request.headers["content-length"] ?? 0) > MAX_BODY_BYTES) {
      reject(ApiErrors.invalidBody(EXPECTED));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) {
        chunks.push(chunk);
        return;
      }
      // Stop keeping bytes; Node discards the rest of the body once the response is sent.
      request.off("data", onData);
      reject(ApiErrors.invalidBody(EXPECTED));
    };
    request.on("data", onData);
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", () => reject(ApiErrors.invalidBody(EXPECTED)));
  });

/** Reads and keeps the request's JSON object (null for an empty body), or throws 400 INVALID_BODY. */
export const readJsonBody = async (request: IncomingMessage): Promise<void> => {
  const bytes = await readBytes(request);
  if (bytes.length === 0) {
    bodies.set(request, null);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw ApiErrors.invalidBody(EXPECTED);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw ApiErrors.invalidBody(EXPECTED);
  bodies.set(request, parsed as JsonObject);
};

const MAX_FIELD_LENGTH: Readonly<Record<string, number>> = { username: 64 };
const DEFAULT_MAX_FIELD_LENGTH = 1024;

/** The named non-empty string fields of the request's JSON body, or 400 INVALID_BODY naming them. */
export const stringFields = <const Names extends readonly string[]>(
  request: IncomingMessage,
  names: Names,
): Record<Names[number], string> => {
  const body = bodies.get(request) ?? null;
  const fields: Record<string, string> = {};
  for (const name of names) {
    const value = body !== null && Object.hasOwn(body, name) ? body[name] : undefined;
    const max = MAX_FIELD_LENGTH[name] ?? DEFAULT_MAX_FIELD_LENGTH;
    if (typeof value !== "string" || value.length === 0 || value.length > max) {
      throw ApiErrors.invalidBody(`a JSON object with the non-empty strings ${names.map((field) => `"${field}"`).join(" and ")}`);
    }
    fields[name] = value;
  }
  return fields as Record<Names[number], string>;
};
