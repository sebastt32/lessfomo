import { describe, expect, it } from "vitest";
import { parseRugCheckReport } from "./parse-rugcheck-report.js";

const BONDING_CURVE = "curveOwner";

const report = (overrides: Record<string, unknown> = {}) => ({
  creator: "creatorWallet",
  creatorBalance: 50_000_000_000_000,
  token: { supply: 1_000_000_000_000_000, decimals: 6 },
  totalHolders: 61,
  graphInsidersDetected: 0,
  knownAccounts: {
    poolOwner: { name: "Pump Fun", type: "AMM" },
    lockerOwner: { name: "Locker", type: "LOCKER" },
    creatorWallet: { name: "Creator", type: "CREATOR" },
  },
  topHolders: [
    { owner: BONDING_CURVE, pct: 70, insider: false },
    { owner: "poolOwner", pct: 10, insider: false },
    { owner: "lockerOwner", pct: 5, insider: false },
    { owner: "creatorWallet", pct: 5, insider: false },
    { owner: "whale", pct: 4, insider: true },
  ],
  ...overrides,
});

describe("parseRugCheckReport", () => {
  it("keeps real wallets and drops the bonding curve, pools and lockers", () => {
    expect(parseRugCheckReport(report(), BONDING_CURVE)).toEqual({
      holders: [
        { owner: "creatorWallet", pct: 5, insider: false },
        { owner: "whale", pct: 4, insider: true },
      ],
      creatorPct: 5,
      insiderNetworks: 0,
      totalHolders: 61,
    });
  });

  it("treats a missing creator balance as zero", () => {
    const parsed = parseRugCheckReport(report({ creatorBalance: undefined }), BONDING_CURVE);

    expect(parsed?.creatorPct).toBe(0);
  });

  it("reads the number of insider networks", () => {
    expect(parseRugCheckReport(report({ graphInsidersDetected: 3 }), BONDING_CURVE)?.insiderNetworks).toBe(3);
  });

  it("returns null when the report has no supply", () => {
    expect(parseRugCheckReport(report({ token: { supply: 0 } }), BONDING_CURVE)).toBeNull();
  });

  it("returns null when the report has no holder list", () => {
    expect(parseRugCheckReport(report({ topHolders: null }), BONDING_CURVE)).toBeNull();
  });

  it("returns null for payloads that are not objects", () => {
    expect(parseRugCheckReport("oops", BONDING_CURVE)).toBeNull();
  });
});
