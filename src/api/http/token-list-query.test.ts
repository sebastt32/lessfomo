import { describe, expect, it } from "vitest";
import { ApiError } from "./api-error.js";
import { parseTokenListQuery } from "./token-list-query.js";

const NOW = new Date("2026-11-14T12:00:00.000Z");
const parse = (query: string) => parseTokenListQuery(new URLSearchParams(query), NOW);
const rejection = (query: string): { status: number; code: string; message: string } => {
  try {
    parse(query);
  } catch (error) {
    if (error instanceof ApiError) return { status: error.status, code: error.code, message: error.message };
    throw error;
  }
  throw new Error(`"${query}" was accepted`);
};

describe("parseTokenListQuery", () => {
  it("defaults to every token, newest first, 50 per page", () => {
    expect(parse("")).toEqual({
      from: null,
      to: null,
      statuses: [],
      lifecycle: null,
      minScore: null,
      minSmartWallets: 1,
      search: null,
      sort: { field: "detectedAt", direction: "desc" },
      page: 1,
      pageSize: 50,
      now: NOW,
    });
  });

  it("reads every filter, full ISO instants and unencoded commas and colons included", () => {
    expect(
      parse(
        "from=2026-11-01T05:00:00.000Z&to=2026-11-02&status=passed,unverified&lifecycle=dead&minScore=42.5&q=%20Pepe%20&sort=liquidity:asc&page=3&pageSize=20",
      ),
    ).toEqual({
      from: new Date("2026-11-01T05:00:00.000Z"),
      to: new Date("2026-11-02T00:00:00.000Z"),
      statuses: ["passed", "unverified"],
      lifecycle: "dead",
      minScore: 42.5,
      minSmartWallets: 1,
      search: "Pepe",
      sort: { field: "liquidity", direction: "asc" },
      page: 3,
      pageSize: 20,
      now: NOW,
    });
  });

  it("accepts every sort field, with or without a direction", () => {
    expect(parse("sort=maxScore:desc").sort).toEqual({ field: "maxScore", direction: "desc" });
    expect(parse("sort=peakMarketCapSol").sort).toEqual({ field: "peakMarketCapSol", direction: "desc" });
    expect(parse("sort=detectedAt%3Aasc").sort).toEqual({ field: "detectedAt", direction: "asc" });
  });

  it("clamps the page size to 1..200 and ignores an empty search", () => {
    expect(parse("pageSize=500").pageSize).toBe(200);
    expect(parse("pageSize=0").pageSize).toBe(1);
    expect(parse("q=%20%20").search).toBeNull();
  });

  it.each([
    ["from=yesterday", "from"],
    ["from=2026-13-01", "from"],
    ["to=2026-11-01T25:00:00Z", "to"],
    ["status=passed,maybe", "status"],
    ["status=", "status"],
    ["status=passed,,failed", "status"],
    ["lifecycle=zombie", "lifecycle"],
    ["minScore=abc", "minScore"],
    ["minScore=101", "minScore"],
    ["minScore=-1", "minScore"],
    ["sort=price:desc", "sort"],
    ["sort=maxScore:up", "sort"],
    ["page=0", "page"],
    ["page=1.5", "page"],
    ["pageSize=ten", "pageSize"],
    [`q=${"x".repeat(101)}`, "q"],
    ["minSmartWallets=-1", "minSmartWallets"],
    ["minSmartWallets=1.5", "minSmartWallets"],
    ["minSmartWallets=two", "minSmartWallets"],
    ["minSmartWallets=", "minSmartWallets"],
    ["minSmartWallets=99999999999999999999", "minSmartWallets"],
    ["sort=smartWallets:asc", "sort"],
  ])("answers 400 INVALID_QUERY naming the parameter for %s", (query, parameter) => {
    const error = rejection(query);

    expect(error).toMatchObject({ status: 400, code: "INVALID_QUERY" });
    expect(error.message).toContain(`"${parameter}"`);
  });

  it("reads minSmartWallets as an integer, 1 by default, treating values below 1 as 1", () => {
    expect(parse("").minSmartWallets).toBe(1);
    expect(parse("minSmartWallets=0").minSmartWallets).toBe(1);
    expect(parse("minSmartWallets=3").minSmartWallets).toBe(3);
  });

  it("sorts by smart wallets, most first, without changing the sort error message", () => {
    expect(parse("sort=smartWallets:desc").sort).toEqual({ field: "smartWallets", direction: "desc" });
    expect(parse("sort=smartWallets").sort).toEqual({ field: "smartWallets", direction: "desc" });
    expect(rejection("sort=smartWallets:asc").message).toBe(
      'Invalid query parameter "sort": expected one of detectedAt, maxScore, peakMarketCapSol, liquidity with :asc or :desc',
    );
    expect(rejection("minSmartWallets=-1").message).toBe('Invalid query parameter "minSmartWallets": expected an integer of at least 1');
  });
});
