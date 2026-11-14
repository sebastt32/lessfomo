import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/pump-sell-logs.json" with { type: "json" };
import { decodePumpTradeEvent, PUMP_TRADE_EVENT_DISCRIMINATOR } from "./decode-pump-trade-event.js";

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
