export interface LoginThrottleOptions {
  /** Failed attempts allowed per username and client IP in one window. */
  readonly maxFailures: number;
  readonly windowMs: number;
  /** Most (username, client IP) pairs remembered at once. */
  readonly maxEntries: number;
}

export const DEFAULT_LOGIN_THROTTLE: LoginThrottleOptions = { maxFailures: 5, windowMs: 15 * 60_000, maxEntries: 10_000 };

export type AttemptDecision = { readonly allowed: true } | { readonly allowed: false; readonly retryAfterSeconds: number };

interface Entry {
  failures: number;
  readonly windowEndsAt: number;
}

/**
 * Limits password guessing: 5 failed attempts per (username, client IP) in 15 minutes, then every
 * attempt is refused for the rest of that window (decision D3). The window starts at the first
 * failure and is not extended by refused attempts.
 *
 * Kept in memory (attempts are forgotten on restart) and bounded: when full, expired entries are
 * dropped first and then the oldest one, so a flood of made-up usernames cannot exhaust memory.
 */
export class LoginThrottle {
  /** In insertion order, so the first key is the oldest window. */
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly clock: () => Date,
    private readonly options: LoginThrottleOptions = DEFAULT_LOGIN_THROTTLE,
  ) {}

  /**
   * Call before checking a password. An allowed attempt counts as failed until `succeeded` says
   * otherwise, so attempts made in parallel cannot exceed the limit.
   */
  attempt(username: string, clientIp: string): AttemptDecision {
    const now = this.clock().getTime();
    const key = keyOf(username, clientIp);
    const entry = this.entries.get(key);
    if (entry === undefined || entry.windowEndsAt <= now) {
      this.entries.delete(key);
      this.makeRoom(now);
      this.entries.set(key, { failures: 1, windowEndsAt: now + this.options.windowMs });
      return { allowed: true };
    }
    if (entry.failures >= this.options.maxFailures) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((entry.windowEndsAt - now) / 1000)) };
    }
    entry.failures += 1;
    return { allowed: true };
  }

  /** The password was right: forget the failed attempts of this username and client IP. */
  succeeded(username: string, clientIp: string): void {
    this.entries.delete(keyOf(username, clientIp));
  }

  /** Number of (username, client IP) pairs remembered. */
  size(): number {
    return this.entries.size;
  }

  private makeRoom(now: number): void {
    if (this.entries.size < this.options.maxEntries) return;
    for (const [key, entry] of this.entries) if (entry.windowEndsAt <= now) this.entries.delete(key);
    while (this.entries.size >= this.options.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) return;
      this.entries.delete(oldest.value);
    }
  }
}

const keyOf = (username: string, clientIp: string): string => `${username.toLowerCase()}\n${clientIp}`;
