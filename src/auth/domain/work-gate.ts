import { AuthError } from "./auth-error.js";

export interface WorkGateOptions {
  /** Pieces of work that run at the same time. */
  readonly maxConcurrent: number;
  /** Pieces of work that may wait for a slot; one more is refused. */
  readonly maxQueued: number;
}

/**
 * Password hashing and verification: 4 at once (scrypt runs on Node's 4 pool threads, about 110 ms
 * and 32 MiB each) and at most 32 waiting, so the longest wait is about a second.
 */
export const DEFAULT_PASSWORD_WORK: WorkGateOptions = { maxConcurrent: 4, maxQueued: 32 };

/**
 * Password work of signed-in users (changing the password) has its own, smaller bound, so a flood
 * of sign-ins cannot keep a signed-in user from replacing a password.
 */
export const DEFAULT_SIGNED_IN_PASSWORD_WORK: WorkGateOptions = { maxConcurrent: 2, maxQueued: 8 };

/** Seconds a refused client is told to wait (`Retry-After`). */
export const BUSY_RETRY_AFTER_SECONDS = 2;

/**
 * Bounds expensive work that anyone can ask for (a sign-in costs a scrypt verification whatever the
 * username): a few run at once, a short queue waits in order, and beyond that `run` refuses with
 * `AuthError("SERVER_BUSY")` without starting the work, so a flood costs neither CPU nor memory.
 */
export class WorkGate {
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly options: WorkGateOptions = DEFAULT_PASSWORD_WORK) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.running >= this.options.maxConcurrent) {
      if (this.waiting.length >= this.options.maxQueued) throw new AuthError("SERVER_BUSY", BUSY_RETRY_AFTER_SECONDS);
      // Whoever finishes hands its slot over, so `running` already counts this work when it resumes.
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.running += 1;
    }
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next === undefined) this.running -= 1;
      else next();
    }
  }
}
