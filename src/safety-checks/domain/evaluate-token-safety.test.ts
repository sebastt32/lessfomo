import { describe, expect, it } from "vitest";
import { DEFAULT_SAFETY_THRESHOLDS, evaluateTokenSafety } from "./evaluate-token-safety.js";
import type { TokenSafetySnapshot } from "./token-safety-snapshot.js";

const safeSnapshot = (): TokenSafetySnapshot => ({
  authorities: { mintAuthority: null, freezeAuthority: null, dangerousExtensions: [] },
  distribution: {
    holders: [
      { owner: "a", pct: 5, insider: false },
      { owner: "b", pct: 4, insider: false },
    ],
    creatorPct: 2,
    insiderNetworks: 0,
    totalHolders: 120,
  },
});

const codesOf = (snapshot: TokenSafetySnapshot) =>
  evaluateTokenSafety(snapshot, DEFAULT_SAFETY_THRESHOLDS).failures.map((f) => f.code);

describe("evaluateTokenSafety", () => {
  it("passes a token with revoked authorities and a distributed supply", () => {
    const report = evaluateTokenSafety(safeSnapshot(), DEFAULT_SAFETY_THRESHOLDS);

    expect(report).toEqual({
      passed: true,
      failures: [],
      metrics: { top10Pct: 9, creatorPct: 2, totalHolders: 120 },
    });
  });

  it("fails when the mint authority is still active", () => {
    const snapshot = safeSnapshot();
    const unsafe = { ...snapshot, authorities: { ...snapshot.authorities, mintAuthority: "dev" } };

    expect(codesOf(unsafe)).toEqual(["MINT_AUTHORITY_ACTIVE"]);
  });

  it("fails when the freeze authority is still active", () => {
    const snapshot = safeSnapshot();
    const unsafe = { ...snapshot, authorities: { ...snapshot.authorities, freezeAuthority: "dev" } };

    expect(codesOf(unsafe)).toEqual(["FREEZE_AUTHORITY_ACTIVE"]);
  });

  it("fails when the mint has a dangerous token extension", () => {
    const snapshot = safeSnapshot();
    const unsafe = {
      ...snapshot,
      authorities: { ...snapshot.authorities, dangerousExtensions: ["permanentDelegate"] },
    };

    const report = evaluateTokenSafety(unsafe, DEFAULT_SAFETY_THRESHOLDS);

    expect(report.failures).toEqual([
      { code: "DANGEROUS_EXTENSION", detail: "Active extensions: permanentDelegate" },
    ]);
  });

  it("fails when the top 10 holders own more than the allowed share", () => {
    const snapshot = safeSnapshot();
    const holders = Array.from({ length: 12 }, (_, i) => ({ owner: `w${i}`, pct: 4, insider: false }));
    const unsafe = { ...snapshot, distribution: { ...snapshot.distribution, holders } };

    const report = evaluateTokenSafety(unsafe, DEFAULT_SAFETY_THRESHOLDS);

    expect(report.metrics.top10Pct).toBe(40);
    expect(report.failures.map((f) => f.code)).toEqual(["TOP_HOLDERS_CONCENTRATED"]);
  });

  it("allows the top 10 holders to own exactly the threshold", () => {
    const snapshot = safeSnapshot();
    const holders = Array.from({ length: 10 }, (_, i) => ({ owner: `w${i}`, pct: 3, insider: false }));

    expect(codesOf({ ...snapshot, distribution: { ...snapshot.distribution, holders } })).toEqual([]);
  });

  it("fails when the creator holds more than the allowed share", () => {
    const snapshot = safeSnapshot();
    const unsafe = { ...snapshot, distribution: { ...snapshot.distribution, creatorPct: 15 } };

    expect(codesOf(unsafe)).toEqual(["CREATOR_HOLDS_TOO_MUCH"]);
  });

  it("fails when insider networks are detected", () => {
    const snapshot = safeSnapshot();
    const unsafe = { ...snapshot, distribution: { ...snapshot.distribution, insiderNetworks: 2 } };

    expect(codesOf(unsafe)).toEqual(["INSIDER_NETWORK_DETECTED"]);
  });

  it("reports every failed rule at once", () => {
    const unsafe: TokenSafetySnapshot = {
      authorities: { mintAuthority: "dev", freezeAuthority: "dev", dangerousExtensions: [] },
      distribution: { holders: [], creatorPct: 50, insiderNetworks: 0, totalHolders: 1 },
    };

    expect(codesOf(unsafe)).toEqual([
      "MINT_AUTHORITY_ACTIVE",
      "FREEZE_AUTHORITY_ACTIVE",
      "CREATOR_HOLDS_TOO_MUCH",
    ]);
  });
});
