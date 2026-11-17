/** An error answered as `{ "error": { "code", "message" } }` with its HTTP status (docs/API.md). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Extra response headers, e.g. `Retry-After`. */
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const ApiErrors = {
  badRequestTarget: () => new ApiError(400, "BAD_REQUEST", "Request target is not a valid URL"),
  invalidMint: () => new ApiError(400, "INVALID_MINT", "Mint is not a base58 address"),
  invalidInterval: () => new ApiError(400, "INVALID_INTERVAL", "Interval must be one of 1s, 1m, 5m"),
  invalidQuery: (parameter: string, expected: string) =>
    new ApiError(400, "INVALID_QUERY", `Invalid query parameter "${parameter}": expected ${expected}`),
  tokenNotFound: () => new ApiError(404, "TOKEN_NOT_FOUND", "Token was never seen"),
  invalidAddress: () => new ApiError(400, "INVALID_ADDRESS", "Address is not a base58 address"),
  walletNotFound: () => new ApiError(404, "WALLET_NOT_FOUND", "Wallet has no closed results"),
  routeNotFound: () => new ApiError(404, "NOT_FOUND", "Route not found"),
  methodNotAllowed: () => new ApiError(405, "METHOD_NOT_ALLOWED", "Only GET is supported"),
  unauthenticated: () => new ApiError(401, "UNAUTHENTICATED", "Sign in required"),
  invalidCredentials: () => new ApiError(401, "INVALID_CREDENTIALS", "Invalid username or password"),
  invalidCurrentPassword: () => new ApiError(401, "INVALID_CREDENTIALS", "Current password is not correct"),
  tooManyAttempts: (retryAfterSeconds: number) =>
    new ApiError(429, "TOO_MANY_ATTEMPTS", "Too many failed attempts, try again later", { "retry-after": String(retryAfterSeconds) }),
  weakPassword: (minLength: number) =>
    new ApiError(400, "WEAK_PASSWORD", `New password must have at least ${minLength} characters and differ from the current one`),
  invalidBody: (expected: string) => new ApiError(400, "INVALID_BODY", `Invalid request body: expected ${expected}`),
  forbiddenOrigin: () => new ApiError(403, "FORBIDDEN_ORIGIN", "Requests from this origin are not allowed"),
  internal: () => new ApiError(500, "INTERNAL_ERROR", "Unexpected server error"),
} as const;
