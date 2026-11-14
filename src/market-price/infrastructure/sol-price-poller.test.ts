import { afterEach, describe, expect, it, vi } from "vitest";
import type { SolPriceSource } from "./public-price-sources.js";
import { SolPricePoller } from "./sol-price-poller.js";

const sources: SolPriceSource[] = [
  { name: "first", url: "https://first.example/price", parse: (body) => (body as { p?: number }).p ?? null },
  { name: "second", url: "https://second.example/price", parse: (body) => (body as { p?: number }).p ?? null },
];

type Reply = { status: number; body: unknown } | Error | "hang";

/** Fake fetch answering each URL with queued replies. */
const fakeFetch = (replies: Record<string, Reply[]>) => {
  const calls: string[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const key = String(url);
    calls.push(key);
    const reply = replies[key]?.shift() ?? new Error("no reply");
    if (reply === "hang") {
      return new Promise((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted"))),
      );
    }
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  };
  return { fetch, calls };
};

const pollers: SolPricePoller[] = [];
const poller = (fetch: typeof globalThis.fetch, options: { timeoutMs?: number; intervalMs?: number } = {}) => {
  const created = new SolPricePoller({ sources, fetch, ...options });
  pollers.push(created);
  return created;
};

afterEach(() => {
  for (const p of pollers.splice(0)) p.stop();
  vi.useRealTimers();
});

describe("SolPricePoller", () => {
  it("is unknown before the first poll", () => {
    expect(poller(fakeFetch({}).fetch).current()).toBeNull();
  });

  it("uses the first source that answers with a valid price", async () => {
    const { fetch, calls } = fakeFetch({ "https://first.example/price": [{ status: 200, body: { p: 150 } }] });
    const prices = poller(fetch);

    await prices.poll();

    expect(prices.current()).toBe(150);
    expect(calls).toEqual(["https://first.example/price"]);
  });

  it.each<[string, Reply]>([
    ["a network error", new Error("ECONNRESET")],
    ["an HTTP error", { status: 451, body: { msg: "restricted location" } }],
    ["an unexpected body", { status: 200, body: { other: 1 } }],
  ])("falls back to the next source after %s", async (_, reply) => {
    const { fetch, calls } = fakeFetch({
      "https://first.example/price": [reply],
      "https://second.example/price": [{ status: 200, body: { p: 151 } }],
    });
    const prices = poller(fetch);

    await prices.poll();

    expect(prices.current()).toBe(151);
    expect(calls).toEqual(["https://first.example/price", "https://second.example/price"]);
  });

  it("falls back after a source times out", async () => {
    const { fetch } = fakeFetch({
      "https://first.example/price": ["hang"],
      "https://second.example/price": [{ status: 200, body: { p: 152 } }],
    });
    const prices = poller(fetch, { timeoutMs: 20 });

    await prices.poll();

    expect(prices.current()).toBe(152);
  });

  it("becomes null when every source fails", async () => {
    const { fetch } = fakeFetch({
      "https://first.example/price": [{ status: 200, body: { p: 150 } }, new Error("down")],
      "https://second.example/price": [{ status: 500, body: {} }],
    });
    const prices = poller(fetch);

    await prices.poll();
    await prices.poll();

    expect(prices.current()).toBeNull();
  });

  it("notifies subscribers only when the price changes, isolating broken ones", async () => {
    const { fetch } = fakeFetch({
      "https://first.example/price": [
        { status: 200, body: { p: 150 } },
        { status: 200, body: { p: 150 } },
        { status: 200, body: { p: 149.5 } },
      ],
    });
    const prices = poller(fetch);
    const seen: number[] = [];
    prices.subscribe(() => {
      throw new Error("broken client");
    });
    const unsubscribe = prices.subscribe((solUsd) => seen.push(solUsd));

    await prices.poll();
    await prices.poll();
    await prices.poll();
    unsubscribe();

    expect(seen).toEqual([150, 149.5]);
  });

  it("polls right away and then on every interval until stopped", async () => {
    vi.useFakeTimers();
    const { fetch, calls } = fakeFetch({
      "https://first.example/price": [
        { status: 200, body: { p: 1 } },
        { status: 200, body: { p: 2 } },
        { status: 200, body: { p: 3 } },
      ],
    });
    const prices = poller(fetch, { intervalMs: 60_000 });

    prices.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(prices.current()).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(prices.current()).toBe(2);
    prices.stop();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(prices.current()).toBe(2);
    expect(calls).toHaveLength(2);
  });
});
