import { describe, expect, it } from "vitest";
import { encodeBase58 } from "./base58.js";

describe("encodeBase58", () => {
  it("encodes 32 zero bytes as the System Program address", () => {
    expect(encodeBase58(new Uint8Array(32))).toBe("11111111111111111111111111111111");
  });

  it("keeps one leading '1' per leading zero byte", () => {
    expect(encodeBase58(Uint8Array.from([0, 0, 1]))).toBe("112");
  });

  it("encodes multi-byte values", () => {
    expect(encodeBase58(Uint8Array.from([0xff, 0xff]))).toBe("LUv");
  });

  it("encodes an empty input as an empty string", () => {
    expect(encodeBase58(new Uint8Array(0))).toBe("");
  });
});
