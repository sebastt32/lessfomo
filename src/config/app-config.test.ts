import { describe, expect, it } from "vitest";
import { loadAppConfig } from "./app-config.js";

const publicMin = (value: string | undefined) =>
  loadAppConfig(value === undefined ? {} : { PUBLIC_MIN_SMART_WALLETS: value }, new Date()).api.publicMinSmartWallets;

describe("loadAppConfig", () => {
  it("reads PUBLIC_MIN_SMART_WALLETS as a positive integer, 5 by default", () => {
    expect(publicMin(undefined)).toBe(5);
    expect(publicMin("1")).toBe(1);
    expect(publicMin("8")).toBe(8);
  });

  it("falls back to 5 for an invalid PUBLIC_MIN_SMART_WALLETS", () => {
    for (const invalid of ["", "0", "-3", "2.5", "five", "1e3", "99999999999999999999"]) expect(publicMin(invalid)).toBe(5);
  });
});
