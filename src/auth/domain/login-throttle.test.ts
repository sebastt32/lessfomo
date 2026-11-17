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

  it("keeps bounded memory: expired entries make room, live ones are never dropped", () => {
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

  it("keeps a locked username locked while made-up usernames fill the memory", () => {
    const { throttle } = setup({ maxFailures: 5, windowMs: 15 * MINUTE, maxEntries: 50, maxFailuresPerIp: 1000 });
    for (let i = 0; i < 5; i += 1) expect(throttle.attempt("admin", "1.1.1.1")).toEqual({ allowed: true });
    expect(throttle.attempt("admin", "1.1.1.1")).toMatchObject({ allowed: false });

    for (let i = 0; i < 500; i += 1) throttle.attempt(`junk${i}`, `10.0.${i % 250}.${i % 7}`);

    expect(throttle.size()).toBe(50);
    expect(throttle.attempt("admin", "1.1.1.1")).toMatchObject({ allowed: false });
  });

  it("fails closed for new usernames while full of live entries, until one expires", () => {
    const { throttle, advance } = setup({ maxFailures: 5, windowMs: 15 * MINUTE, maxEntries: 3, maxFailuresPerIp: 1000 });
    throttle.attempt("a", "1.1.1.1");
    advance(MINUTE);
    throttle.attempt("b", "2.2.2.2");
    throttle.attempt("c", "3.3.3.3");

    // Refused until the oldest entry (a, 1 minute old) leaves its window.
    expect(throttle.attempt("d", "4.4.4.4")).toEqual({ allowed: false, retryAfterSeconds: 14 * 60 });
    expect(throttle.size()).toBe(3);
    // Usernames already remembered keep their own count.
    expect(throttle.attempt("b", "2.2.2.2")).toEqual({ allowed: true });

    advance(14 * MINUTE);
    expect(throttle.attempt("d", "4.4.4.4")).toEqual({ allowed: true });
    expect(throttle.size()).toBe(3);
  });

  it("blocks a client IP after 30 failures across usernames, and a success does not reset it", () => {
    const { throttle, advance } = setup();
    for (let i = 0; i < 30; i += 1) expect(throttle.attempt(`user${i}`, "1.1.1.1")).toEqual({ allowed: true });
    advance(5 * MINUTE);

    expect(throttle.attempt("admin", "1.1.1.1")).toEqual({ allowed: false, retryAfterSeconds: 600 });
    expect(throttle.attempt("admin", "2.2.2.2")).toEqual({ allowed: true });

    // One right password gives back that one attempt only.
    throttle.succeeded("user0", "1.1.1.1");
    expect(throttle.attempt("admin", "1.1.1.1")).toEqual({ allowed: true });
    expect(throttle.attempt("admin", "1.1.1.1")).toMatchObject({ allowed: false });

    advance(10 * MINUTE);
    expect(throttle.attempt("other", "1.1.1.1")).toEqual({ allowed: true });
  });

  it("does not count an attempt that was forgiven because its password was never checked", () => {
    const { throttle } = setup();
    for (let i = 0; i < 40; i += 1) {
      expect(throttle.attempt("admin", "1.1.1.1")).toEqual({ allowed: true });
      throttle.forgive("admin", "1.1.1.1");
    }
    expect(throttle.size()).toBe(0);

    for (let i = 0; i < 5; i += 1) expect(throttle.attempt("admin", "1.1.1.1")).toEqual({ allowed: true });
    expect(throttle.attempt("admin", "1.1.1.1")).toMatchObject({ allowed: false });
  });
});
