import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimitedQueue } from "./rate-limited-queue.js";

describe("RateLimitedQueue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("processes items in order, spaced by the minimum interval", async () => {
    const processed: string[] = [];
    const queue = new RateLimitedQueue<string>({
      minIntervalMs: 1_000,
      maxSize: 10,
      process: async (item) => {
        processed.push(item);
      },
    });

    queue.enqueue("a");
    queue.enqueue("b");
    queue.enqueue("c");

    await vi.advanceTimersByTimeAsync(0);
    expect(processed).toEqual(["a"]);
    await vi.advanceTimersByTimeAsync(999);
    expect(processed).toEqual(["a"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(processed).toEqual(["a", "b"]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(processed).toEqual(["a", "b", "c"]);
  });

  it("drops the oldest pending items when full and reports them", async () => {
    const processed: string[] = [];
    const dropped: string[] = [];
    const queue = new RateLimitedQueue<string>({
      minIntervalMs: 1_000,
      maxSize: 2,
      process: async (item) => {
        processed.push(item);
      },
      onDrop: (item) => dropped.push(item),
    });

    queue.enqueue("a");
    await vi.advanceTimersByTimeAsync(0);
    queue.enqueue("b");
    queue.enqueue("c");
    queue.enqueue("d");

    expect(dropped).toEqual(["b"]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(processed).toEqual(["a", "c", "d"]);
  });

  it("keeps processing after an item fails", async () => {
    const processed: string[] = [];
    const errors: unknown[] = [];
    const queue = new RateLimitedQueue<string>({
      minIntervalMs: 100,
      maxSize: 10,
      process: async (item) => {
        if (item === "bad") throw new Error("boom");
        processed.push(item);
      },
      onError: (_item, error) => errors.push(error),
    });

    queue.enqueue("bad");
    queue.enqueue("good");
    await vi.advanceTimersByTimeAsync(200);

    expect(errors).toHaveLength(1);
    expect(processed).toEqual(["good"]);
  });

  it("stops processing pending items after clear", async () => {
    const processed: string[] = [];
    const queue = new RateLimitedQueue<string>({
      minIntervalMs: 100,
      maxSize: 10,
      process: async (item) => {
        processed.push(item);
      },
    });

    queue.enqueue("a");
    queue.enqueue("b");
    await vi.advanceTimersByTimeAsync(0);
    queue.clear();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(processed).toEqual(["a"]);
  });
});
