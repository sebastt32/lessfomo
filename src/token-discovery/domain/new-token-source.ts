import type { NewToken } from "./new-token.js";

/** Port: any real-time feed that reports newly created tokens. */
export interface NewTokenSource {
  start(onToken: (token: NewToken) => void): void;
  stop(): void;
}
