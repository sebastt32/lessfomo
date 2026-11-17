export interface LoginThrottleOptions {
  /** Failed attempts allowed per username and client IP in one window. */
  readonly maxFailures: number;
  readonly windowMs: number;
  /** Most (username, client IP) pairs, and most client IPs, remembered at once. */
  readonly maxEntries: number;
  /** Failed attempts allowed per client IP, whatever the usernames, in one window (30 unless given). */
  readonly maxFailuresPerIp?: number;
}

export const DEFAULT_LOGIN_THROTTLE: LoginThrottleOptions = {
  maxFailures: 5,
  windowMs: 15 * 60_000,
  maxEntries: 10_000,
  maxFailuresPerIp: 30,
};

export type AttemptDecision = { readonly allowed: true } | { readonly allowed: false; readonly retryAfterSeconds: number };

interface Entry {
  failures: number;
  readonly windowEndsAt: number;
}

/**
 * Failed attempts per key, each key in its own window that starts at its first failure.
 *
 * Bounded without ever forgetting a key that is inside its window: only expired entries are
 * dropped. While it is full of live entries, keys it does not know are refused (fail closed) until
 * the oldest window ends, so a flood of made-up keys can neither exhaust memory nor push out a
 * locked key to unlock it.
 */
class FailureWindows {
  /** In insertion order; every window has the same length, so the first entry expires first. */
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly maxFailures: number,
    private readonly windowMs: number,
    private readonly maxEntries: number,
  ) {}

  /** Seconds until `key` may be attempted, or null when it may be attempted now. */
  blockedFor(key: string, now: number): number | null {
    const entry = this.entries.get(key);
    if (entry !== undefined && entry.windowEndsAt > now) {
      return entry.failures >= this.maxFailures ? secondsUntil(entry.windowEndsAt, now) : null;
    }
    this.entries.delete(key);
    if (this.entries.size < this.maxEntries) return null;
    for (const [other, { windowEndsAt }] of this.entries) if (windowEndsAt <= now) this.entries.delete(other);
    if (this.entries.size < this.maxEntries) return null;
    const oldest = this.entries.values().next();
    return oldest.done ? null : secondsUntil(oldest.value.windowEndsAt, now);
  }

  /** Counts one failure; call only after `blockedFor` answered null for the same key and time. */
  count(key: string, now: number): void {
    const entry = this.entries.get(key);
    if (entry === undefined) this.entries.set(key, { failures: 1, windowEndsAt: now + this.windowMs });
    else entry.failures += 1;
  }

  /** Takes back one counted failure. */
  uncount(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    entry.failures -= 1;
    if (entry.failures <= 0) this.entries.delete(key);
  }

  forget(key: string): void {
    this.entries.delete(key);
  }

  size(): number {
    return this.entries.size;
  }
}

const secondsUntil = (time: number, now: number): number => Math.max(1, Math.ceil((time - now) / 1000));

/**
 * Limits password guessing (decision D3), in two ways at once:
 * - 5 failed attempts per (username, client IP) in 15 minutes;
 * - 30 failed attempts per client IP in 15 minutes, whatever the usernames, so trying many
 *   usernames from one address is limited too.
 * Past either limit every attempt is refused for the rest of that window. A window starts at its
 * first failure and is not extended by refused attempts.
 *
 * Kept in memory (attempts are forgotten on restart) and bounded, failing closed when full: see
 * `FailureWindows`.
 */
export class LoginThrottle {
  private readonly pairs: FailureWindows;
  private readonly ips: FailureWindows;

  constructor(
    private readonly clock: () => Date,
    options: LoginThrottleOptions = DEFAULT_LOGIN_THROTTLE,
  ) {
    const perIp = options.maxFailuresPerIp ?? DEFAULT_LOGIN_THROTTLE.maxFailuresPerIp ?? 30;
    this.pairs = new FailureWindows(options.maxFailures, options.windowMs, options.maxEntries);
    this.ips = new FailureWindows(perIp, options.windowMs, options.maxEntries);
  }

  /**
   * Call before checking a password. An allowed attempt counts as failed until `succeeded` (or
   * `forgive`) says otherwise, so attempts made in parallel cannot exceed the limits.
   */
  attempt(username: string, clientIp: string): AttemptDecision {
    const now = this.clock().getTime();
    const pair = pairKey(username, clientIp);
    const retryAfterSeconds = this.pairs.blockedFor(pair, now) ?? this.ips.blockedFor(clientIp, now);
    if (retryAfterSeconds !== null) return { allowed: false, retryAfterSeconds };
    this.pairs.count(pair, now);
    this.ips.count(clientIp, now);
    return { allowed: true };
  }

  /**
   * The password was right: forget the failed attempts of this username and client IP. The client
   * IP only gets this one attempt back, so one valid account does not reset its limit.
   */
  succeeded(username: string, clientIp: string): void {
    this.pairs.forget(pairKey(username, clientIp));
    this.ips.uncount(clientIp);
  }

  /** The allowed attempt never checked a password (the server was busy): do not count it at all. */
  forgive(username: string, clientIp: string): void {
    this.pairs.uncount(pairKey(username, clientIp));
    this.ips.uncount(clientIp);
  }

  /** Number of (username, client IP) pairs remembered. */
  size(): number {
    return this.pairs.size();
  }
}

const pairKey = (username: string, clientIp: string): string => `${username.toLowerCase()}\n${clientIp}`;
