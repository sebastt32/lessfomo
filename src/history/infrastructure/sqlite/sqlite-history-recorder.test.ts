import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { MomentumSnapshot } from "../../../momentum/application/momentum-tracker.js";
import type { Trade } from "../../../momentum/domain/trade.js";
import type { ScreeningResult } from "../../../screening/token-screener.js";
import type { NewToken } from "../../../token-discovery/domain/new-token.js";
import { SqliteHistoryRecorder } from "./sqlite-history-recorder.js";

const token: NewToken = {
  mint: "mint1",
  name: "Ghost",
  symbol: "GHOST",
  creator: "dev",
  signature: "createSig",
  metadataUri: "https://example.com/meta.json",
  bondingCurve: "curve",
  pool: "pump",
  initialBuyTokens: 1000,
  initialBuySol: 0.5,
  marketCapSol: 28,
  detectedAt: new Date("2026-11-13T20:00:00.000Z"),
};

const trade: Trade = {
  signature: "tradeSig",
  mint: "mint1",
  trader: "fan",
  side: "buy",
  solAmount: 0.25,
  tokenAmount: 9000,
  priceSol: 0.00003,
  timestamp: new Date("2026-11-13T20:01:00.000Z"),
};

const snapshot: MomentumSnapshot = {
  mint: "mint1",
  at: new Date("2026-11-13T20:02:00.000Z"),
  momentum: {
    score: 63,
    components: { activity: 0.5, acceleration: 0.8, buyPressure: 0.6 },
    metrics: {
      uniqueBuyers1m: 8,
      uniqueBuyers5m: 25,
      avgUniqueBuyersPrevMinutes: 4.25,
      buyVolumeSol5m: 3.2,
      sellVolumeSol5m: 0.8,
      tradeCount5m: 40,
      medianBuySol5m: 0.1,
      priceChange5mPct: 35.5,
      lastPriceSol: 0.00004,
    },
  },
};

const tempDirs: string[] = [];
const tempDbPath = () => {
  const dir = mkdtempSync(join(tmpdir(), "lessfomo-history-"));
  tempDirs.push(dir);
  return join(dir, "nested", "history.db");
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("SqliteHistoryRecorder", () => {
  it("stores new tokens", () => {
    const recorder = new SqliteHistoryRecorder(":memory:");
    recorder.recordToken(token);

    expect(recorder.query("SELECT * FROM tokens")).toEqual([
      {
        mint: "mint1",
        symbol: "GHOST",
        name: "Ghost",
        creator: "dev",
        bonding_curve: "curve",
        metadata_uri: "https://example.com/meta.json",
        create_signature: "createSig",
        initial_buy_sol: 0.5,
        market_cap_sol: 28,
        detected_at: token.detectedAt.getTime(),
      },
    ]);
  });

  it("stores screening results, including failures and unverified reasons", () => {
    const recorder = new SqliteHistoryRecorder(":memory:");
    const at = new Date("2026-11-13T20:01:00.000Z");
    const failed: ScreeningResult = {
      token,
      status: "failed",
      report: {
        passed: false,
        failures: [{ code: "NOT_ENOUGH_HOLDERS", detail: "Only 3 holder(s) (min 20)" }],
        metrics: { top10Pct: 12.5, creatorPct: 1, totalHolders: 3 },
      },
    };
    const unverified: ScreeningResult = { token, status: "unverified", reason: "RugCheck responded 429" };

    recorder.recordScreening(failed, at);
    recorder.recordScreening(unverified, at);

    expect(recorder.query("SELECT * FROM screenings ORDER BY id")).toEqual([
      {
        id: 1,
        mint: "mint1",
        evaluated_at: at.getTime(),
        status: "failed",
        reason: null,
        failure_codes: '["NOT_ENOUGH_HOLDERS"]',
        top10_pct: 12.5,
        creator_pct: 1,
        total_holders: 3,
      },
      {
        id: 2,
        mint: "mint1",
        evaluated_at: at.getTime(),
        status: "unverified",
        reason: "RugCheck responded 429",
        failure_codes: null,
        top10_pct: null,
        creator_pct: null,
        total_holders: null,
      },
    ]);
  });

  it("stores trades once, ignoring duplicates", () => {
    const recorder = new SqliteHistoryRecorder(":memory:");

    recorder.recordTrade(trade);
    recorder.recordTrade(trade);

    expect(recorder.query("SELECT * FROM trades")).toEqual([
      {
        signature: "tradeSig",
        mint: "mint1",
        trader: "fan",
        side: "buy",
        sol_amount: 0.25,
        token_amount: 9000,
        price_sol: 0.00003,
        timestamp: trade.timestamp.getTime(),
      },
    ]);
  });

  it("stores momentum snapshots with every component and metric", () => {
    const recorder = new SqliteHistoryRecorder(":memory:");

    recorder.recordMomentum(snapshot);

    expect(recorder.query("SELECT * FROM momentum_snapshots")).toEqual([
      {
        mint: "mint1",
        at: snapshot.at.getTime(),
        score: 63,
        activity: 0.5,
        acceleration: 0.8,
        buy_pressure: 0.6,
        unique_buyers_1m: 8,
        unique_buyers_5m: 25,
        avg_unique_buyers_prev: 4.25,
        buy_volume_sol_5m: 3.2,
        sell_volume_sol_5m: 0.8,
        trade_count_5m: 40,
        median_buy_sol_5m: 0.1,
        price_change_5m_pct: 35.5,
        last_price_sol: 0.00004,
      },
    ]);
  });

  it("persists to disk, creating missing folders, and reopens without losing data", () => {
    const path = tempDbPath();
    const first = new SqliteHistoryRecorder(path);
    first.recordToken(token);
    first.close();

    const reopened = new SqliteHistoryRecorder(path);
    reopened.recordToken(token);

    expect(reopened.query("SELECT mint FROM tokens")).toEqual([{ mint: "mint1" }]);
    reopened.close();

    const raw = new DatabaseSync(path);
    expect(raw.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    raw.close();
  });
});
