import { describe, expect, it } from "vitest";
import fixture from "./dexscreener-tokens.fixture.json" with { type: "json" };
import { DexScreenerMarketData, parseDexScreenerTokens } from "./dexscreener-market-data.js";

const CURVE_MINT = "A2ArUMBc24kad4kCXMqsfy8JJSrMYNjnzun9ZRy8pump";
const POOL_MINT = "7kXjwrxd488DkTvgu7AybnNcWUU4yM9G6SQxCbVTpump";
const solPerUsd = (pair: { priceNative: string; priceUsd: string }) => Number(pair.priceNative) / Number(pair.priceUsd);
const [curvePair, poolPair] = fixture;

describe("parseDexScreenerTokens", () => {
  it("reads the bonding curve pair of a real response, converting USD volume to SOL", () => {
    const quotes = parseDexScreenerTokens(fixture, [CURVE_MINT]);
    const toSol = (usd: number) => Math.round(usd * solPerUsd(curvePair!) * 1e9) / 1e9;

    expect(quotes.get(CURVE_MINT)).toEqual({
      priceSol: 0.0000002082,
      liquiditySol: null,
      migrated: false,
      windows: {
        m5: { volumeSol: toSol(12459.62), buys: 265, sells: 232 },
        h1: { volumeSol: toSol(60473.87), buys: 1268, sells: 869 },
        h6: { volumeSol: toSol(60473.87), buys: 1268, sells: 869 },
        h24: { volumeSol: toSol(60473.87), buys: 1268, sells: 869 },
      },
    });
  });

  it("reads the pool liquidity in SOL of a migrated token", () => {
    expect(parseDexScreenerTokens(fixture, [POOL_MINT]).get(POOL_MINT)).toMatchObject({
      priceSol: 0.0000000000058,
      liquiditySol: 0.005648,
      migrated: true,
    });
    expect(poolPair?.dexId).toBe("pumpswap");
  });

  it("prefers the migrated pool with the most liquidity over the bonding curve pair", () => {
    const pool = { ...poolPair, baseToken: { ...poolPair!.baseToken, address: CURVE_MINT } };
    const smallPool = { ...pool, dexId: "raydium", liquidity: { usd: 0.01, base: 1, quote: 0.0001 } };

    expect(parseDexScreenerTokens([curvePair, smallPool, pool], [CURVE_MINT]).get(CURVE_MINT)).toMatchObject({
      liquiditySol: 0.005648,
      migrated: true,
    });
  });

  it("ignores pairs of other tokens, pairs not quoted in SOL and malformed payloads", () => {
    const usdQuoted = { ...curvePair, quoteToken: { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" } };

    expect(parseDexScreenerTokens(fixture, ["Other111"]).size).toBe(0);
    expect(parseDexScreenerTokens([usdQuoted], [CURVE_MINT]).size).toBe(0);
    expect(parseDexScreenerTokens({ pairs: null }, [CURVE_MINT]).size).toBe(0);
    expect(parseDexScreenerTokens([{ ...curvePair, priceNative: "abc" }], [CURVE_MINT]).size).toBe(0);
  });
});

describe("DexScreenerMarketData", () => {
  const setup = (respond: (url: string) => Response = () => Response.json(fixture)) => {
    const urls: string[] = [];
    const waits: number[] = [];
    let clock = 0;
    const source = new DexScreenerMarketData({
      baseUrl: "https://dex.test",
      minIntervalMs: 1_000,
      fetchFn: async (input) => {
        urls.push(String(input));
        clock += 100;
        return respond(String(input));
      },
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
    });
    return { source, urls, waits };
  };

  it("asks for at most 30 mints per request, keeping a minimum interval between requests", async () => {
    const { source, urls, waits } = setup();
    const mints = Array.from({ length: 61 }, (_, i) => `mint${i}`);

    await source.quotes(mints);

    expect(urls).toEqual([
      `https://dex.test/tokens/v1/solana/${mints.slice(0, 30).join(",")}`,
      `https://dex.test/tokens/v1/solana/${mints.slice(30, 60).join(",")}`,
      "https://dex.test/tokens/v1/solana/mint60",
    ]);
    expect(waits).toEqual([900, 900]);
  });

  it("returns the quotes of every batch", async () => {
    const { source } = setup();

    const quotes = await source.quotes([CURVE_MINT, POOL_MINT]);

    expect([...quotes.keys()].sort()).toEqual([POOL_MINT, CURVE_MINT].sort());
  });

  it("skips a failing batch and keeps the others", async () => {
    const { source } = setup((url) => (url.includes("mint0") ? new Response("busy", { status: 429 }) : Response.json(fixture)));
    const mints = [...Array.from({ length: 30 }, (_, i) => `mint${i}`), CURVE_MINT];

    const quotes = await source.quotes(mints);

    expect([...quotes.keys()]).toEqual([CURVE_MINT]);
  });

  it("makes no request without mints", async () => {
    const { source, urls } = setup();

    expect((await source.quotes([])).size).toBe(0);
    expect(urls).toEqual([]);
  });
});
