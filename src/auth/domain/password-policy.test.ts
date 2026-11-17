import { describe, expect, it } from "vitest";
import { isStrongEnoughPassword, MIN_PASSWORD_LENGTH } from "./password-policy.js";

describe("password policy", () => {
  it("requires at least 12 characters", () => {
    expect(MIN_PASSWORD_LENGTH).toBe(12);
    expect(isStrongEnoughPassword("a".repeat(11))).toBe(false);
    expect(isStrongEnoughPassword("a".repeat(12))).toBe(true);
    expect(isStrongEnoughPassword("")).toBe(false);
  });

  it("counts characters, not UTF-16 units", () => {
    expect(isStrongEnoughPassword("😀".repeat(6))).toBe(false);
    expect(isStrongEnoughPassword("😀".repeat(12))).toBe(true);
  });
});
