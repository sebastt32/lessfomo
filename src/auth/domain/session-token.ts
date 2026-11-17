import { createHash, randomBytes } from "node:crypto";

const TOKEN_BYTES = 32;
/** 32 bytes as unpadded base64url. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export interface NewSessionToken {
  /** Sent to the client once, in its cookie; never stored. */
  readonly token: string;
  /** What is stored: a stolen database does not contain usable sessions. */
  readonly tokenHash: string;
}

/** SHA-256 (hex) of a session token. The token has 256 bits of entropy, so a fast hash is enough. */
export const hashSessionToken = (token: string): string => createHash("sha256").update(token).digest("hex");

export const isSessionToken = (value: string): boolean => TOKEN.test(value);

export const newSessionToken = (): NewSessionToken => {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  return { token, tokenHash: hashSessionToken(token) };
};
