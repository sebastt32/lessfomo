import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CycleEventThrottle } from "./cycle-event-throttle.js";

describe("CycleEventThrottle", () => {
  let sent: string[] = [];
  let throttle: CycleEventThrottle<string>;

  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    throttle = new CycleEventThrottle({ minIntervalMs: 10_000, send: (mint, value) => sent.push(`${mint}:${value}`) });
  });

  afterEach(() => {
    throttle.stop();
    vi.useRealTimers();
  });

  it("sends the first event of a token at once", () => {
    throttle.offer("a", "peak-1", false);

    expect(sent).toEqual(["a:peak-1"]);
  });

  it("sends at most one event per token every 10 seconds, the latest one when the interval ends", () => {
    throttle.offer("a", "peak-1", false);
    vi.advanceTimersByTime(3_000);
    throttle.offer("a", "peak-2", false);
    throttle.offer("a", "peak-3", false);
    expect(sent).toEqual(["a:peak-1"]);

    vi.advanceTimersByTime(6_999);
    expect(sent).toEqual(["a:peak-1"]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual(["a:peak-1", "a:peak-3"]);

    // The interval counts from the last event sent.
    vi.advanceTimersByTime(9_999);
    throttle.offer("a", "peak-4", false);
    expect(sent).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual(["a:peak-1", "a:peak-3", "a:peak-4"]);
  });

  it("sends again at once after 10 quiet seconds", () => {
    throttle.offer("a", "peak-1", false);
    vi.advanceTimersByTime(10_000);
    throttle.offer("a", "peak-2", false);

    expect(sent).toEqual(["a:peak-1", "a:peak-2"]);
  });

  it("always sends phase changes at once, replacing a waiting event", () => {
    throttle.offer("a", "peak-1", false);
    throttle.offer("a", "peak-2", false);
    throttle.offer("a", "crashed", true);
    throttle.offer("a", "exploding-again", true);

    expect(sent).toEqual(["a:peak-1", "a:crashed", "a:exploding-again"]);
    vi.advanceTimersByTime(60_000);
    expect(sent).toHaveLength(3);
  });

  it("throttles each token on its own", () => {
    throttle.offer("a", "peak-1", false);
    throttle.offer("b", "peak-1", false);
    throttle.offer("a", "peak-2", false);

    expect(sent).toEqual(["a:peak-1", "b:peak-1"]);
  });

  it("sends nothing after it stops", () => {
    throttle.offer("a", "peak-1", false);
    throttle.offer("a", "peak-2", false);
    throttle.stop();
    vi.advanceTimersByTime(60_000);

    expect(sent).toEqual(["a:peak-1"]);
  });
});
