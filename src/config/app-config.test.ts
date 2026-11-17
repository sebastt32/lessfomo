import { describe, expect, it } from "vitest";
import { DEFAULT_REPUTATION_RULES } from "../wallet-reputation/domain/reputation-rules.js";
import { loadAppConfig } from "./app-config.js";

const publicMin = (value: string | undefined) =>
  loadAppConfig(value === undefined ? {} : { PUBLIC_MIN_CONVICTION_WALLETS: value }, new Date()).api.publicMinConvictionWallets;

describe("loadAppConfig", () => {
  it("reads PUBLIC_MIN_CONVICTION_WALLETS as a positive integer, 3 by default", () => {
    expect(publicMin(undefined)).toBe(3);
    expect(publicMin("1")).toBe(1);
    expect(publicMin("8")).toBe(8);
  });

  it("falls back to 3 for an invalid PUBLIC_MIN_CONVICTION_WALLETS", () => {
    for (const invalid of ["", "0", "-3", "2.5", "five", "1e3", "99999999999999999999"]) expect(publicMin(invalid)).toBe(3);
  });

  it("no longer reads the retired PUBLIC_MIN_SMART_WALLETS", () => {
    const config = loadAppConfig({ PUBLIC_MIN_SMART_WALLETS: "1" }, new Date());
    expect(config.api.publicMinConvictionWallets).toBe(3);
    expect("publicMinSmartWallets" in config.api).toBe(false);
  });

  it("uses the D7 style thresholds by default: flip within 120 s, conviction ≤ 30%, flipper ≥ 60%", () => {
    expect(loadAppConfig({}, new Date()).walletReputation.rules.style).toEqual({
      flipWindowMs: 120_000,
      convictionMaxFlipRatePct: 30,
      flipperMinFlipRatePct: 60,
    });
    expect(loadAppConfig({}, new Date()).walletReputation.rules).toBe(DEFAULT_REPUTATION_RULES);
  });

  it("reads AUTH_COOKIE_SECURE (only \"true\") and AUTH_SESSION_DAYS (positive integer, 7 by default)", () => {
    const auth = (env: Record<string, string>) => loadAppConfig(env, new Date()).auth;

    expect(auth({})).toEqual({ cookieSecure: false, sessionDays: 7 });
    expect(auth({ AUTH_COOKIE_SECURE: "true", AUTH_SESSION_DAYS: "30" })).toEqual({ cookieSecure: true, sessionDays: 30 });
    for (const invalid of ["", "1", "yes", "TRUE", "false"]) expect(auth({ AUTH_COOKIE_SECURE: invalid }).cookieSecure).toBe(false);
    for (const invalid of ["", "0", "-1", "1.5", "week", "1e2", "99999999999999999999"]) {
      expect(auth({ AUTH_SESSION_DAYS: invalid }).sessionDays).toBe(7);
    }
  });
});
