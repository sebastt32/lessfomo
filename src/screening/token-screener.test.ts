import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NewToken } from "../token-discovery/domain/new-token.js";
import type { NewTokenSource } from "../token-discovery/domain/new-token-source.js";
import { DEFAULT_SAFETY_THRESHOLDS } from "../safety-checks/domain/evaluate-token-safety.js";
import type { ScreeningResult } from "./token-screener.js";
import { TokenScreener } from "./token-screener.js";

const token = (mint: string): NewToken => ({
  mint,
  name: mint,
  symbol: mint.toUpperCase(),
  creator: "creator",
  signature: "sig",
  metadataUri: "uri",
  bondingCurve: "curve",
  pool: "pump",
  initialBuyTokens: 0,
  initialBuySol: 0,
  marketCapSol: 28,
  detectedAt: new Date("2026-11-13T20:00:00.000Z"),
});

class FakeSource implements NewTokenSource {
  private listener: ((token: NewToken) => void) | null = null;
  stopped = false;
  start(onToken: (token: NewToken) => void): void {
    this.listener = onToken;
  }
  stop(): void {
    this.stopped = true;
  }
  emit(newToken: NewToken): void {
    this.listener?.(newToken);
  }
}

const safeAuthorities = { mintAuthority: null, freezeAuthority: null, dangerousExtensions: [] };
const safeDistribution = { holders: [], creatorPct: 0, insiderNetworks: 0, totalHolders: 50 };

const setup = (overrides: Partial<ConstructorParameters<typeof TokenScreener>[0]> = {}) => {
  const source = new FakeSource();
  const results: ScreeningResult[] = [];
  const screener = new TokenScreener({
    source,
    authorityReader: { read: async () => safeAuthorities },
    distributionReader: { read: async () => safeDistribution },
    thresholds: DEFAULT_SAFETY_THRESHOLDS,
    evaluationDelayMs: 1_000,
    minIntervalMs: 100,
    maxPending: 10,
    onResult: (result) => results.push(result),
    ...overrides,
  });
  return { source, results, screener };
};

describe("TokenScreener", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("evaluates a token only after the evaluation delay", async () => {
    const { source, results, screener } = setup();
    screener.start();

    source.emit(token("abc"));
    await vi.advanceTimersByTimeAsync(999);
    expect(results).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(results).toEqual([
      {
        token: token("abc"),
        status: "passed",
        report: { passed: true, failures: [], metrics: { top10Pct: 0, creatorPct: 0, totalHolders: 50 } },
      },
    ]);
  });

  it("marks a token as failed when a safety rule fails", async () => {
    const { source, results, screener } = setup({
      authorityReader: { read: async () => ({ ...safeAuthorities, mintAuthority: "dev" }) },
    });
    screener.start();

    source.emit(token("abc"));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(results[0]?.status).toBe("failed");
    expect(results[0]?.report?.failures.map((f) => f.code)).toEqual(["MINT_AUTHORITY_ACTIVE"]);
  });

  it("marks a token as unverified when a data source fails, never as passed", async () => {
    const { source, results, screener } = setup({
      distributionReader: {
        read: async () => {
          throw new Error("RugCheck responded 429");
        },
      },
    });
    screener.start();

    source.emit(token("abc"));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(results).toEqual([
      { token: token("abc"), status: "unverified", reason: "RugCheck responded 429" },
    ]);
  });

  it("marks a token as unverified when a data source has no data for it", async () => {
    const { source, results, screener } = setup({ authorityReader: { read: async () => null } });
    screener.start();

    source.emit(token("abc"));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(results[0]).toMatchObject({ status: "unverified", reason: "Mint account not found" });
  });

  it("reports tokens skipped because the queue was full", async () => {
    const skipped: string[] = [];
    const { source, screener } = setup({ maxPending: 1, onSkip: (t) => skipped.push(t.mint) });
    screener.start();

    source.emit(token("a"));
    source.emit(token("b"));
    source.emit(token("c"));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(skipped).toEqual(["b"]);
  });

  it("stops the source and pending work on stop", async () => {
    const { source, results, screener } = setup();
    screener.start();

    source.emit(token("abc"));
    screener.stop();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(source.stopped).toBe(true);
    expect(results).toHaveLength(0);
  });
});
