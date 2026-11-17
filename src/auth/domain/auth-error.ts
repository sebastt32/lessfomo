export type AuthErrorCode = "INVALID_CREDENTIALS" | "TOO_MANY_ATTEMPTS" | "WEAK_PASSWORD";

/** A sign-in or password change that was refused. Never carries a password, token or hash. */
export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    /** Seconds until another attempt is allowed (`TOO_MANY_ATTEMPTS` only). */
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(code);
    this.name = "AuthError";
  }
}
