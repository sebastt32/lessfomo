import { describe, expect, it } from "vitest";
import { PUBLIC_SOL_PRICE_SOURCES } from "./public-price-sources.js";

const source = (name: string) => {
  const found = PUBLIC_SOL_PRICE_SOURCES.find((s) => s.name === name);
  if (!found) throw new Error(`no source ${name}`);
  return found;
};

describe("public SOL/USD price sources", () => {
  it("tries Jupiter, then CoinGecko, then Binance, all over HTTPS without keys", () => {
    expect(PUBLIC_SOL_PRICE_SOURCES.map((s) => s.name)).toEqual(["jupiter", "coingecko", "binance"]);
    for (const s of PUBLIC_SOL_PRICE_SOURCES) expect(s.url).toMatch(/^https:\/\//);
  });

  it("parses the Jupiter price v3 response", () => {
    const body = {
      So11111111111111111111111111111111111111112: { usdPrice: 75.72864590309489, decimals: 9, liquidity: 8e8 },
    };

    expect(source("jupiter").parse(body)).toBe(75.72864590309489);
  });

  it("parses the CoinGecko simple price response", () => {
    expect(source("coingecko").parse({ solana: { usd: 75.75 } })).toBe(75.75);
  });

  it("parses the Binance ticker response, whose price is a string", () => {
    expect(source("binance").parse({ symbol: "SOLUSDT", price: "75.81000000" })).toBe(75.81);
  });

  it.each([
    ["jupiter", {}],
    ["jupiter", { So11111111111111111111111111111111111111112: { usdPrice: "75" } }],
    ["jupiter", { So11111111111111111111111111111111111111112: null }],
    ["coingecko", { solana: { usd: 0 } }],
    ["coingecko", { solana: { usd: -1 } }],
    ["coingecko", []],
    ["binance", { price: "not a number" }],
    ["binance", { price: "" }],
    ["binance", { price: 75 }],
    ["binance", null],
  ])("returns null for an unexpected %s response %j", (name, body) => {
    expect(source(name).parse(body)).toBeNull();
  });
});
