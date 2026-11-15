/** An error answered as `{ "error": { "code", "message" } }` with its HTTP status (docs/API.md). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const ApiErrors = {
  badRequestTarget: () => new ApiError(400, "BAD_REQUEST", "Request target is not a valid URL"),
  invalidMint: () => new ApiError(400, "INVALID_MINT", "Mint is not a base58 address"),
  invalidInterval: () => new ApiError(400, "INVALID_INTERVAL", "Interval must be one of 1s, 1m, 5m"),
  tokenNotFound: () => new ApiError(404, "TOKEN_NOT_FOUND", "Token was never seen"),
  routeNotFound: () => new ApiError(404, "NOT_FOUND", "Route not found"),
  methodNotAllowed: () => new ApiError(405, "METHOD_NOT_ALLOWED", "Only GET is supported"),
  internal: () => new ApiError(500, "INTERNAL_ERROR", "Unexpected server error"),
} as const;
