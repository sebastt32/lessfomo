import { describe, expect, it } from "vitest";
import type { MomentumSnapshot } from "../../../momentum/application/momentum-tracker.js";
import type { ScreeningResult } from "../../../screening/token-screener.js";
import type { NewToken } from "../../../token-discovery/domain/new-token.js";
import { SqliteHistoryRecorder } from "./sqlite-history-recorder.js";

const token = (mint: string): NewToken => ({
  mint,
  name: `Name ${mint}`,
  symbol: mint.toUpperCase(),
  creator: "dev",
  signature: "sig",
  metadataUri: "https://example.com/meta.json",
  bondingCurve: "curve",
  pool: "pump",
  initialBuyTokens: 0,
  initialBuySol: 0.5,
  marketCapSol: 28,
  detectedAt: new Date("2026-11-13T20:00:00.000Z"),
});

const failed = (mint: string): ScreeningResult => ({
  token: token(mint),
  status: "failed",
  report: {
    passed: false,
    failures: [{ code: "NOT_ENOUGH_HOLDERS", detail: "" }],
    metrics: { top10Pct: 4.5, creatorPct: 1, totalHolders: 3 },
  },
});

const point = (mint: string, at: string, score: number): MomentumSnapshot => ({
  mint,
  at: new Date(at),
  momentum: {
    score,
    components: { activity: 0.1, acceleration: 0.2, buyPressure: 0.3 },
    metrics: {
      uniqueBuyers1m: 1,
      uniqueBuyers5m: 2,
      avgUniqueBuyersPrevMinutes: 0.5,
      buyVolumeSol5m: 1,
      sellVolumeSol5m: 0.5,
      tradeCount5m: 3,
      medianBuySol5m: 0.2,
      priceChange5mPct: 10,
      lastPriceSol: null,
    },
  },
});

describe("SqliteHistoryRecorder as a history reader", () => {
  it("lists recent screenings newest first with token names", () => {
    const history = new SqliteHistoryRecorder(":memory:");
    history.recordToken(token("a"));
    history.recordToken(token("b"));
    history.recordScreening(failed("a"), new Date("2026-11-13T20:01:00.000Z"));
    history.recordScreening({ token: token("b"), status: "unverified", reason: "RugCheck responded 429" }, new Date("2026-11-13T20:02:00.000Z"));

    expect(history.recentScreenings(10)).toEqual([
      {
        mint: "b",
        symbol: "B",
        name: "Name b",
        status: "unverified",
        reason: "RugCheck responded 429",
        failureCodes: [],
        top10Pct: null,
        creatorPct: null,
        totalHolders: null,
        evaluatedAt: new Date("2026-11-13T20:02:00.000Z"),
      },
      {
        mint: "a",
        symbol: "A",
        name: "Name a",
        status: "failed",
        reason: null,
        failureCodes: ["NOT_ENOUGH_HOLDERS"],
        top10Pct: 4.5,
        creatorPct: 1,
        totalHolders: 3,
        evaluatedAt: new Date("2026-11-13T20:01:00.000Z"),
      },
    ]);
  });

  it("limits recent screenings", () => {
    const history = new SqliteHistoryRecorder(":memory:");
    history.recordToken(token("a"));
    for (let i = 0; i < 5; i += 1) history.recordScreening(failed("a"), new Date(Date.UTC(2026, 10, 13, 20, i)));

    expect(history.recentScreenings(2)).toHaveLength(2);
  });

  it("returns the full history of one token", () => {
    const history = new SqliteHistoryRecorder(":memory:");
    history.recordToken(token("a"));
    history.recordScreening(failed("a"), new Date("2026-11-13T20:01:00.000Z"));
    history.recordMomentum(point("a", "2026-11-13T20:03:00.000Z", 30));
    history.recordMomentum(point("a", "2026-11-13T20:02:00.000Z", 20));

    const detail = history.tokenHistory("a");

    expect(detail?.token).toEqual({
      mint: "a",
      symbol: "A",
      name: "Name a",
      creator: "dev",
      metadataUri: "https://example.com/meta.json",
      initialBuySol: 0.5,
      marketCapSol: 28,
      detectedAt: new Date("2026-11-13T20:00:00.000Z"),
    });
    expect(detail?.status).toBe("failed");
    expect(detail?.screenings.map((s) => s.status)).toEqual(["failed"]);
    expect(detail?.momentum).toEqual([
      {
        at: new Date("2026-11-13T20:02:00.000Z"),
        score: 20,
        components: { activity: 0.1, acceleration: 0.2, buyPressure: 0.3 },
        metrics: {
          uniqueBuyers1m: 1,
          uniqueBuyers5m: 2,
          avgUniqueBuyersPrevMinutes: 0.5,
          buyVolumeSol5m: 1,
          sellVolumeSol5m: 0.5,
          tradeCount5m: 3,
          medianBuySol5m: 0.2,
          priceChange5mPct: 10,
          lastPriceSol: null,
        },
      },
      expect.objectContaining({ score: 30 }),
    ]);
  });

  it("reports a token without screenings as pending", () => {
    const history = new SqliteHistoryRecorder(":memory:");
    history.recordToken(token("a"));

    expect(history.tokenHistory("a")?.status).toBe("pending");
  });

  it("returns null for an unknown token", () => {
    expect(new SqliteHistoryRecorder(":memory:").tokenHistory("nope")).toBeNull();
  });
});
