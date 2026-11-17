import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

export interface ScryptParams {
  /** CPU/memory cost, a power of two. */
  readonly N: number;
  readonly r: number;
  readonly p: number;
}

/** OWASP's scrypt recommendation with the smallest memory footprint (32 MiB per hash): N=2^15, r=8, p=3. */
export const DEFAULT_SCRYPT_PARAMS: ScryptParams = { N: 2 ** 15, r: 8, p: 3 };

const SCHEME = "scrypt";
const SALT_BYTES = 16;
const KEY_BYTES = 64;
/** Upper bounds accepted from a stored hash, so a corrupted row cannot ask for unbounded work. */
const MAX_N = 2 ** 17;
const MAX_R = 16;
const MAX_P = 16;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const INTEGER = /^[1-9]\d{0,6}$/;

const derive = (password: string, salt: Buffer, { N, r, p }: ScryptParams, keyBytes: number): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    // scrypt needs about 128 * N * r bytes; Node's default limit (32 MiB) is exactly that for the defaults.
    scrypt(password.normalize("NFKC"), salt, keyBytes, { N, r, p, maxmem: 256 * N * r }, (error, key) =>
      error === null ? resolve(key) : reject(error),
    );
  });

/**
 * Hashes a password with scrypt and a random 16-byte salt. The result describes itself
 * (`scrypt$N$r$p$salt$hash`, base64url), so parameters can be raised later without a migration.
 */
export const hashPassword = async (password: string, params: ScryptParams = DEFAULT_SCRYPT_PARAMS): Promise<string> => {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, params, KEY_BYTES);
  return [SCHEME, params.N, params.r, params.p, salt.toString("base64url"), key.toString("base64url")].join("$");
};

interface ParsedHash {
  readonly params: ScryptParams;
  readonly salt: Buffer;
  readonly key: Buffer;
}

const parse = (stored: string): ParsedHash | null => {
  const parts = stored.split("$");
  const [scheme, rawN, rawR, rawP, rawSalt, rawKey] = parts;
  if (parts.length !== 6 || scheme !== SCHEME) return null;
  if (rawN === undefined || rawR === undefined || rawP === undefined || rawSalt === undefined || rawKey === undefined) return null;
  if (!INTEGER.test(rawN) || !INTEGER.test(rawR) || !INTEGER.test(rawP)) return null;
  if (!BASE64URL.test(rawSalt) || !BASE64URL.test(rawKey)) return null;
  const params = { N: Number(rawN), r: Number(rawR), p: Number(rawP) };
  const powerOfTwo = params.N >= 2 && (params.N & (params.N - 1)) === 0;
  if (!powerOfTwo || params.N > MAX_N || params.r > MAX_R || params.p > MAX_P) return null;
  const salt = Buffer.from(rawSalt, "base64url");
  const key = Buffer.from(rawKey, "base64url");
  // Only canonical encodings of the expected sizes: anything else was not written by `hashPassword`.
  if (salt.length !== SALT_BYTES || key.length !== KEY_BYTES) return null;
  if (salt.toString("base64url") !== rawSalt || key.toString("base64url") !== rawKey) return null;
  return { params, salt, key };
};

/** True only for the password a stored hash was made from; a malformed or tampered hash is just false. */
export const verifyPassword = async (password: string, stored: string): Promise<boolean> => {
  const parsed = parse(stored);
  if (parsed === null) return false;
  try {
    const key = await derive(password, parsed.salt, parsed.params, parsed.key.length);
    return timingSafeEqual(key, parsed.key);
  } catch {
    return false;
  }
};

let dummy: Promise<string> | null = null;

/** The hash of a random password nobody knows, made once per process with the default parameters. */
export const dummyPasswordHash = (): Promise<string> => {
  dummy ??= hashPassword(randomBytes(32).toString("base64url"));
  return dummy;
};

/**
 * Verifies against the stored hash, or against the dummy hash when there is none (unknown user),
 * so an unknown username costs the same work as a wrong password and timing does not reveal
 * which usernames exist.
 */
export const verifyPasswordOrDummy = async (password: string, stored: string | null): Promise<boolean> => {
  const matches = await verifyPassword(password, stored ?? (await dummyPasswordHash()));
  return stored !== null && matches;
};
