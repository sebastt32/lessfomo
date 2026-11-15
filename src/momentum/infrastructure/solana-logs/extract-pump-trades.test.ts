import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/pump-sell-logs.json" with { type: "json" };
import { extractPumpTrades } from "./extract-pump-trades.js";

const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const tradeData = fixture.logs.find((l) => l.startsWith("Program data: ")) ?? "";

describe("extractPumpTrades", () => {
  it("extracts the trade emitted by the pump.fun program", () => {
    const trades = extractPumpTrades(fixture);

    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ signature: fixture.signature, side: "sell" });
  });

  it("ignores failed transactions", () => {
    expect(extractPumpTrades({ ...fixture, err: { InstructionError: [0, "Custom"] } })).toEqual([]);
  });

  it("ignores trade-shaped data emitted by other programs", () => {
    const logs = [
      "Program FakePump1111111111111111111111111111111111 invoke [1]",
      tradeData,
      "Program FakePump1111111111111111111111111111111111 success",
    ];

    expect(extractPumpTrades({ signature: "sig", err: null, logs })).toEqual([]);
  });

  it("attributes data to pump.fun again after a nested program returns", () => {
    const logs = [
      `Program ${PUMP} invoke [1]`,
      "Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb invoke [2]",
      "Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb success",
      tradeData,
      `Program ${PUMP} success`,
    ];

    expect(extractPumpTrades({ signature: "sig", err: null, logs })).toHaveLength(1);
  });

  it("returns nothing for malformed notifications", () => {
    expect(extractPumpTrades(null)).toEqual([]);
    expect(extractPumpTrades({ signature: "sig", err: null, logs: "nope" })).toEqual([]);
  });
});

describe("extractPumpTrades curve state", () => {
  it("attaches the bonding curve state read from the same event", () => {
    expect(extractPumpTrades(fixture)[0]?.curve).toEqual({ realSolReserves: 16.771318622, progressPct: 48.51, complete: false });
  });
});
