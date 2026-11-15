import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/pump-sell-logs.json" with { type: "json" };
import { decodePumpCurveState, decodePumpTradeEvent, PUMP_TRADE_EVENT_DISCRIMINATOR } from "./decode-pump-trade-event.js";

const fixtureData = (): string => {
  const line = fixture.logs.find((l) => l.startsWith("Program data: "));
  if (line === undefined) throw new Error("fixture has no Program data line");
  return line.slice("Program data: ".length);
};

describe("decodePumpTradeEvent", () => {
  it("decodes a real pump.fun sell event", () => {
    expect(decodePumpTradeEvent(fixtureData(), fixture.signature)).toEqual({
      signature: fixture.signature,
      mint: "Ae5tjBfX5hEKGgK9gHzgcjXES5Kdj1BK23QQfWLVXMAg",
      trader: "57WkTbDxxu3tC9Nhve8hQms5KBRa7MFEPSnnEeThivvX",
      side: "sell",
      solAmount: 0.008199771,
      tokenAmount: 120638.90596,
      priceSol: 46.771318622 / 688242303.931656,
      timestamp: new Date(1794620892 * 1000),
    });
  });

  it("decodes a buy when the is_buy flag is set", () => {
    const bytes = Buffer.from(fixtureData(), "base64");
    bytes[8 + 32 + 8 + 8] = 1;

    expect(decodePumpTradeEvent(bytes.toString("base64"), "sig")?.side).toBe("buy");
  });

  it("ignores events with another discriminator", () => {
    const bytes = Buffer.from(fixtureData(), "base64");
    bytes.fill(0, 0, 8);

    expect(decodePumpTradeEvent(bytes.toString("base64"), "sig")).toBeNull();
  });

  it("ignores payloads shorter than the trade event prefix", () => {
    const truncated = Buffer.concat([PUMP_TRADE_EVENT_DISCRIMINATOR, Buffer.alloc(50)]);

    expect(decodePumpTradeEvent(truncated.toString("base64"), "sig")).toBeNull();
  });

  it("ignores trades on curves quoted in another token, whose SOL reserves are zero", () => {
    const bytes = Buffer.from(fixtureData(), "base64");
    bytes.fill(0, 8 + 32 + 8 + 8 + 1 + 32 + 8, 8 + 32 + 8 + 8 + 1 + 32 + 8 + 8);

    expect(decodePumpTradeEvent(bytes.toString("base64"), "sig")).toBeNull();
  });

  it("ignores events with empty token reserves", () => {
    const bytes = Buffer.from(fixtureData(), "base64");
    bytes.fill(0, 8 + 32 + 8 + 8 + 1 + 32 + 8 + 8, 8 + 32 + 8 + 8 + 1 + 32 + 8 + 8 + 8);

    expect(decodePumpTradeEvent(bytes.toString("base64"), "sig")).toBeNull();
  });
});

describe("decodePumpCurveState", () => {
  /** Offset of real_sol_reserves: discriminator, mint, amounts, is_buy, user, timestamp, virtual reserves. */
  const REAL_SOL_OFFSET = 8 + 32 + 8 + 8 + 1 + 32 + 8 + 8 + 8;
  const REAL_TOKEN_OFFSET = REAL_SOL_OFFSET + 8;

  it("reads the real reserves and the curve progress of a real pump.fun sell event", () => {
    // Real reserves: 16.771318622 SOL and 408,342,303.931656 tokens left of the initial 793,100,000.
    expect(decodePumpCurveState(fixtureData())).toEqual({
      realSolReserves: 16.771318622,
      progressPct: 48.51,
      complete: false,
    });
  });

  it("reports a complete curve, at 100%, once no real tokens are left", () => {
    const bytes = Buffer.from(fixtureData(), "base64");
    const virtualTokens = 8 + 32 + 8 + 8 + 1 + 32 + 8 + 8;
    bytes.writeBigUInt64LE(279_900_000_000_000n, virtualTokens);
    bytes.writeBigUInt64LE(0n, REAL_TOKEN_OFFSET);

    expect(decodePumpCurveState(bytes.toString("base64"))).toMatchObject({ progressPct: 100, complete: true });
  });

  it("reports an unknown progress for curves created with other initial reserves", () => {
    const bytes = Buffer.from(fixtureData(), "base64");
    bytes.writeBigUInt64LE(1_000_000n, REAL_SOL_OFFSET);

    expect(decodePumpCurveState(bytes.toString("base64"))).toEqual({
      realSolReserves: 0.001,
      progressPct: null,
      complete: false,
    });
  });

  it("ignores events too short to hold the real reserves", () => {
    const truncated = Buffer.from(fixtureData(), "base64").subarray(0, REAL_TOKEN_OFFSET + 4);

    expect(decodePumpCurveState(truncated.toString("base64"))).toBeNull();
  });

  it("ignores events with another discriminator or quoted in another token", () => {
    const other = Buffer.from(fixtureData(), "base64");
    other.fill(0, 0, 8);
    const quoted = Buffer.from(fixtureData(), "base64");
    quoted.fill(0, REAL_SOL_OFFSET - 16, REAL_SOL_OFFSET - 8);

    expect(decodePumpCurveState(other.toString("base64"))).toBeNull();
    expect(decodePumpCurveState(quoted.toString("base64"))).toBeNull();
  });
});
