import { describe, expect, it } from "vitest";
import { LoginThrottle } from "./login-throttle.js";

const MINUTE = 60_000;

const setup = (options?: ConstructorParameters<typeof LoginThrottle>[1]) => {
  let now = Date.parse("2026-11-17T10:00:00.000Z");
  const throttle = new LoginThrottle(() => new Date(now), options);
  return { throttle, advance: (ms: number) => void (now += ms) };
};

describe("LoginThrottle", () => {
  it("allows 5 failed attempts per username and client IP, then blocks for the rest of the 15 minute window", () => {
    const { throttle, advance } = setup();

    for (let i = 0; i < 5; i += 1) {
      expect(throttle.attempt("admin", "1.1.1.1")).toEqual({ allowed: true });
      advance(MINUTE);
    }

    // The window started at the first attempt, 5 minutes ago.
    expect(throttle.attempt("admin", "1.1.1.1")).toEqual({ allowed: false, retryAfterSeconds: 600 });
    advance(10 * MINUTE - 1);
    expect(throttle.attempt("admin", "1.1.1.1")).toEqual({ allowed: false, retryAfterSeconds: 1 });
    advance(1);
    expect(throttle.attempt("admin", "1.1.1.1")).toEqual({ allowed: true });
  });

  it("does not extend the block when blocked attempts keep coming", () => {
    const { throttle, advance } = setup();
    for (let i = 0; i < 5; i += 1) throttle.attempt("admin", "1.1.1.1");
    for (let i = 0; i < 50; i += 1) throttle.attempt("admin", "1.1.1.1");

    advance(15 * MINUTE);

    expect(throttle.attempt("admin", "1.1.1.1")).toEqual({ allowed: true });
  });

  it("starts over after a successful sign-in", () => {
    const { throttle } = setup();
    for (let i = 0; i < 4; i += 1) throttle.attempt("admin", "1.1.1.1");

    throttle.succeeded("admin", "1.1.1.1");

    for (let i = 0; i < 5; i += 1) expect(throttle.attempt("admin", "1.1.1.1")).toEqual({ allowed: true });
    expect(throttle.attempt("admin", "1.1.1.1")).toMatchObject({ allowed: false });
  });

  it("counts each username and client IP apart, ignoring username case", () => {
    const { throttle } = setup();
    for (let i = 0; i < 5; i += 1) throttle.attempt("Admin", "1.1.1.1");

    expect(throttle.attempt("ADMIN", "1.1.1.1")).toMatchObject({ allowed: false });
    expect(throttle.attempt("admin", "2.2.2.2")).toEqual({ allowed: true });
    expect(throttle.attempt("other", "1.1.1.1")).toEqual({ allowed: true });
  });

  it("keeps bounded memory: expired entries go first, then the oldest", () => {
    const { throttle, advance } = setup({ maxFailures: 5, windowMs: 15 * MINUTE, maxEntries: 3 });
    throttle.attempt("a", "ip");
    advance(16 * MINUTE);
    throttle.attempt("b", "ip");
    throttle.attempt("c", "ip");
    throttle.attempt("d", "ip");
    expect(throttle.size()).toBe(3);

    throttle.attempt("e", "ip");

    expect(throttle.size()).toBe(3);
    for (let i = 0; i < 1000; i += 1) throttle.attempt(`user${i}`, "ip");
    expect(throttle.size()).toBe(3);
  });
});
