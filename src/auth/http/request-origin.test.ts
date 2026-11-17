import { describe, expect, it } from "vitest";
import { clientIpOf, isAllowedOrigin, isHttpsRequest } from "./request-origin.js";

const ALLOWED = ["http://localhost:5173", "https://app.example"];

describe("CSRF origin rule", () => {
  it("accepts a request without an Origin header (not a browser cross-site request)", () => {
    expect(isAllowedOrigin(undefined, "api.example", ALLOWED)).toBe(true);
  });

  it("accepts the API's own origin (same host as the Host header) and the allowed CORS origins", () => {
    expect(isAllowedOrigin("https://lessfomo.example", "lessfomo.example", ALLOWED)).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:3001", "127.0.0.1:3001", ALLOWED)).toBe(true);
    expect(isAllowedOrigin("https://LESSFOMO.example", "lessfomo.EXAMPLE", ALLOWED)).toBe(true);
    expect(isAllowedOrigin("http://localhost:5173", "backend:3001", ALLOWED)).toBe(true);
    expect(isAllowedOrigin("https://app.example", "backend:3001", ALLOWED)).toBe(true);
  });

  it("rejects every other origin", () => {
    for (const origin of [
      "https://evil.example",
      "null",
      "",
      "https://lessfomo.example.evil.example",
      "https://lessfomo.example:8443",
      "https://lessfomo.example/path",
      "ftp://lessfomo.example",
      "lessfomo.example",
      "https://app.example.evil",
    ]) {
      expect(isAllowedOrigin(origin, "lessfomo.example", ALLOWED), origin).toBe(false);
    }
    expect(isAllowedOrigin("https://lessfomo.example", undefined, ALLOWED)).toBe(false);
  });
});

describe("client IP for throttling", () => {
  it("is the first hop of X-Forwarded-For, otherwise the socket address", () => {
    expect(clientIpOf({ "x-forwarded-for": "203.0.113.7, 10.0.0.2" }, "10.0.0.9")).toBe("203.0.113.7");
    expect(clientIpOf({ "x-forwarded-for": " 2001:db8::1 " }, "10.0.0.9")).toBe("2001:db8::1");
    expect(clientIpOf({}, "10.0.0.9")).toBe("10.0.0.9");
    expect(clientIpOf({}, undefined)).toBe("unknown");
  });

  it("ignores a first hop that is not an IP address", () => {
    expect(clientIpOf({ "x-forwarded-for": "not-an-ip, 203.0.113.7" }, "10.0.0.9")).toBe("10.0.0.9");
    expect(clientIpOf({ "x-forwarded-for": `${"1".repeat(5000)}` }, "10.0.0.9")).toBe("10.0.0.9");
    expect(clientIpOf({ "x-forwarded-for": "" }, "10.0.0.9")).toBe("10.0.0.9");
  });
});

describe("HTTPS detection for the Secure cookie flag", () => {
  it("follows X-Forwarded-Proto only", () => {
    expect(isHttpsRequest({ "x-forwarded-proto": "https" })).toBe(true);
    expect(isHttpsRequest({ "x-forwarded-proto": "HTTPS, http" })).toBe(true);
    expect(isHttpsRequest({ "x-forwarded-proto": "http" })).toBe(false);
    expect(isHttpsRequest({ "x-forwarded-proto": "http, https" })).toBe(false);
    expect(isHttpsRequest({ "x-forwarded-ssl": "on", forwarded: "proto=https" })).toBe(false);
    expect(isHttpsRequest({})).toBe(false);
  });
});
