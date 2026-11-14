import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { MomentumSnapshot } from "../../momentum/application/momentum-tracker.js";
import type { Trade } from "../../momentum/domain/trade.js";
import type { ScreeningResult } from "../../screening/token-screener.js";
import type { NewToken } from "../../token-discovery/domain/new-token.js";
import type { HistoryReader } from "../domain/history-reader.js";
import type { HistoryRecorder } from "../domain/history-recorder.js";
import { PostgresHistory } from "./postgres/postgres-history.js";
import { SqliteHistoryRecorder } from "./sqlite/sqlite-history-recorder.js";

type History = HistoryRecorder & HistoryReader;

interface OpenedHistory {
  readonly history: History;
  /** Number of rows stored in a table. */
  count(table: string): Promise<number>;
  close(): Promise<void>;
}

interface Adapter {
  readonly name: string;
  setup(): Promise<void>;
  open(): Promise<OpenedHistory>;
  teardown(): Promise<void>;
}

const token = (mint: string, overrides: Partial<NewToken> = {}): NewToken => ({
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
  ...overrides,
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

const trade: Trade = {
  signature: "tradeSig",
  mint: "a",
  trader: "fan",
  side: "buy",
  solAmount: 0.25,
  tokenAmount: 9000,
  priceSol: 0.00003,
  timestamp: new Date("2026-11-13T20:01:00.000Z"),
};

const sqliteAdapter: Adapter = {
  name: "SQLite",
  setup: async () => {},
  open: async () => {
    const history = new SqliteHistoryRecorder(":memory:");
    return {
      history,
      count: async (table) => Number(history.query(`SELECT COUNT(*) AS n FROM ${table}`)[0]?.["n"]),
      close: () => history.close(),
    };
  },
  teardown: async () => {},
};

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
    });
  });

/** A throwaway PostgreSQL server; every test gets its own empty database. */
const createPostgresAdapter = (): Adapter & { databaseUrl(database: string): string } => {
  let server: EmbeddedPostgres | null = null;
  let dataDir = "";
  let port = 0;
  let databases = 0;
  const databaseUrl = (database: string) => `postgres://postgres:postgres@127.0.0.1:${port}/${database}`;

  return {
    name: "PostgreSQL",
    databaseUrl,
    setup: async () => {
      dataDir = mkdtempSync(join(tmpdir(), "lessfomo-pg-"));
      port = await freePort();
      server = new EmbeddedPostgres({
        databaseDir: join(dataDir, "data"),
        port,
        user: "postgres",
        password: "postgres",
        persistent: false,
        onLog: () => {},
        onError: () => {},
      });
      await server.initialise();
      await server.start();
    },
    open: async () => {
      databases += 1;
      const database = `history_${databases}`;
      const admin = new pg.Client(databaseUrl("postgres"));
      await admin.connect();
      await admin.query(`CREATE DATABASE ${database}`);
      await admin.end();

      const history = await PostgresHistory.connect(databaseUrl(database));
      return {
        history,
        count: async (table) => Number((await history.query(`SELECT COUNT(*) AS n FROM ${table}`))[0]?.["n"]),
        close: () => history.close(),
      };
    },
    teardown: async () => {
      await server?.stop();
      if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    },
  };
};

const postgresAdapter = createPostgresAdapter();

describe.each([sqliteAdapter, postgresAdapter])("$name history", (adapter) => {
  const opened: OpenedHistory[] = [];
  const open = async (): Promise<History> => {
    const store = await adapter.open();
    opened.push(store);
    return store.history;
  };
  const countOf = async (table: string): Promise<number> => {
    const store = opened.at(-1);
    if (!store) throw new Error("no history opened");
    return store.count(table);
  };

  beforeAll(() => adapter.setup(), 120_000);
  afterEach(async () => {
    for (const store of opened.splice(0)) await store.close();
  });
  afterAll(() => adapter.teardown(), 60_000);

  it("lists recent screenings newest first with token names", async () => {
    const history = await open();
    await history.recordToken(token("a"));
    await history.recordToken(token("b"));
    await history.recordScreening(failed("a"), new Date("2026-11-13T20:01:00.000Z"));
    await history.recordScreening(
      { token: token("b"), status: "unverified", reason: "RugCheck responded 429" },
      new Date("2026-11-13T20:02:00.000Z"),
    );

    expect(await history.recentScreenings(10)).toEqual([
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

  it("breaks evaluation time ties by insertion order, newest first", async () => {
    const history = await open();
    const at = new Date("2026-11-13T20:01:00.000Z");
    await history.recordScreening(failed("a"), at);
    const passed: ScreeningResult = {
      token: token("a"),
      status: "passed",
      report: { passed: true, failures: [], metrics: { top10Pct: 1, creatorPct: 0, totalHolders: 40 } },
    };
    await history.recordScreening(passed, at);

    expect((await history.recentScreenings(10)).map((s) => s.status)).toEqual(["passed", "failed"]);
  });

  it("returns empty names for screenings of tokens that were never stored", async () => {
    const history = await open();
    await history.recordScreening(failed("ghost"), new Date("2026-11-13T20:01:00.000Z"));

    expect(await history.recentScreenings(10)).toEqual([
      expect.objectContaining({ mint: "ghost", symbol: "", name: "" }),
    ]);
  });

  it("limits recent screenings", async () => {
    const history = await open();
    await history.recordToken(token("a"));
    for (let i = 0; i < 5; i += 1) await history.recordScreening(failed("a"), new Date(Date.UTC(2026, 10, 13, 20, i)));

    const screenings = await history.recentScreenings(2);

    expect(screenings.map((s) => s.evaluatedAt)).toEqual([
      new Date(Date.UTC(2026, 10, 13, 20, 4)),
      new Date(Date.UTC(2026, 10, 13, 20, 3)),
    ]);
  });

  it("returns the full history of one token", async () => {
    const history = await open();
    await history.recordToken(token("a"));
    await history.recordScreening(failed("a"), new Date("2026-11-13T20:01:00.000Z"));
    await history.recordScreening(
      { token: token("a"), status: "unverified", reason: "RugCheck responded 429" },
      new Date("2026-11-13T20:04:00.000Z"),
    );
    await history.recordMomentum(point("a", "2026-11-13T20:03:00.000Z", 30));
    await history.recordMomentum(point("a", "2026-11-13T20:02:00.000Z", 20));

    const detail = await history.tokenHistory("a");

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
    expect(detail?.status).toBe("unverified");
    expect(detail?.screenings.map((s) => s.status)).toEqual(["unverified", "failed"]);
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

  it("keeps the first copy of a token detected twice", async () => {
    const history = await open();
    await history.recordToken(token("a"));
    await history.recordToken(token("a", { symbol: "OTHER" }));

    expect((await history.tokenHistory("a"))?.token.symbol).toBe("A");
    expect(await countOf("tokens")).toBe(1);
  });

  it("replaces a momentum snapshot taken at the same moment", async () => {
    const history = await open();
    await history.recordToken(token("a"));
    await history.recordMomentum(point("a", "2026-11-13T20:02:00.000Z", 20));
    const later = point("a", "2026-11-13T20:02:00.000Z", 45);
    await history.recordMomentum({
      ...later,
      momentum: { ...later.momentum, metrics: { ...later.momentum.metrics, lastPriceSol: 0.00004 } },
    });

    const momentum = (await history.tokenHistory("a"))?.momentum;

    expect(momentum).toHaveLength(1);
    expect(momentum?.[0]?.score).toBe(45);
    expect(momentum?.[0]?.metrics.lastPriceSol).toBe(0.00004);
  });

  it("stores trades once, ignoring duplicates", async () => {
    const history = await open();
    await history.recordTrade(trade);
    await history.recordTrade(trade);
    await history.recordTrade({ ...trade, side: "sell" });

    expect(await countOf("trades")).toBe(2);
  });

  it("reports a token without screenings as pending", async () => {
    const history = await open();
    await history.recordToken(token("a"));

    expect((await history.tokenHistory("a"))?.status).toBe("pending");
  });

  it("returns null for an unknown token", async () => {
    const history = await open();

    expect(await history.tokenHistory("nope")).toBeNull();
  });

  describe("token chart", () => {
    /** 2026-11-13T20:00:00Z in Unix seconds; a multiple of 60 and 300. */
    const T0 = Date.UTC(2026, 10, 13, 20) / 1000;
    let sequence = 0;
    const tradeAt = (ms: number, overrides: Partial<Trade> = {}): Trade => {
      sequence += 1;
      return { ...trade, signature: `sig${sequence}`, timestamp: new Date(ms), ...overrides };
    };

    it("returns null for an unknown token", async () => {
      const history = await open();

      expect(await history.tokenChart("nope", 60, 300)).toBeNull();
    });

    it("returns no candles and no dev trades for a token without trades", async () => {
      const history = await open();
      await history.recordToken(token("a"));

      expect(await history.tokenChart("a", 60, 300)).toEqual({ candles: [], devTrades: [] });
    });

    it("aggregates trades into OHLCV buckets, oldest first, omitting empty buckets", async () => {
      const history = await open();
      await history.recordToken(token("a"));
      const base = T0 * 1000;
      // First minute: open 2, high 5, low 1, close 3.
      await history.recordTrade(tradeAt(base + 59_999, { priceSol: 3, side: "sell", solAmount: 0.5 }));
      await history.recordTrade(tradeAt(base, { priceSol: 2, solAmount: 1 }));
      await history.recordTrade(tradeAt(base + 10_000, { priceSol: 5, solAmount: 0.25 }));
      await history.recordTrade(tradeAt(base + 20_000, { priceSol: 1, side: "sell", solAmount: 0.25 }));
      // Third minute only; the second minute has no trades.
      await history.recordTrade(tradeAt(base + 120_000, { priceSol: 4, solAmount: 2 }));
      // Another token never leaks into this chart.
      await history.recordTrade(tradeAt(base + 30_000, { mint: "b", priceSol: 100 }));

      const chart = await history.tokenChart("a", 60, 300);

      expect(chart?.candles).toEqual([
        {
          start: new Date(base),
          open: 2,
          high: 5,
          low: 1,
          close: 3,
          volumeSol: 2,
          buyVolumeSol: 1.25,
          sellVolumeSol: 0.75,
          trades: 4,
        },
        {
          start: new Date(base + 120_000),
          open: 4,
          high: 4,
          low: 4,
          close: 4,
          volumeSol: 2,
          buyVolumeSol: 2,
          sellVolumeSol: 0,
          trades: 1,
        },
      ]);
    });

    it("splits buckets exactly at the interval boundary", async () => {
      const history = await open();
      await history.recordToken(token("a"));
      const base = T0 * 1000;
      await history.recordTrade(tradeAt(base + 999, { priceSol: 1 }));
      await history.recordTrade(tradeAt(base + 1_000, { priceSol: 2 }));
      await history.recordTrade(tradeAt(base + 299_999, { priceSol: 3 }));
      await history.recordTrade(tradeAt(base + 300_000, { priceSol: 4 }));

      const seconds = await history.tokenChart("a", 1, 300);
      const fiveMinutes = await history.tokenChart("a", 300, 300);

      expect(seconds?.candles.map((c) => [c.start.getTime() / 1000 - T0, c.close])).toEqual([
        [0, 1],
        [1, 2],
        [299, 3],
        [300, 4],
      ]);
      expect(fiveMinutes?.candles.map((c) => [c.start.getTime() / 1000 - T0, c.open, c.close, c.trades])).toEqual([
        [0, 1, 3, 3],
        [300, 4, 4, 1],
      ]);
    });

    it("breaks timestamp ties by insertion order for open and close", async () => {
      const history = await open();
      await history.recordToken(token("a"));
      const at = T0 * 1000 + 5_000;
      await history.recordTrade(tradeAt(at, { priceSol: 7 }));
      await history.recordTrade(tradeAt(at, { priceSol: 9 }));
      await history.recordTrade(tradeAt(at, { priceSol: 8 }));

      const candle = (await history.tokenChart("a", 60, 300))?.candles[0];

      expect(candle).toMatchObject({ open: 7, high: 9, low: 7, close: 8, trades: 3 });
    });

    it("keeps only the most recent candles up to the limit, oldest first", async () => {
      const history = await open();
      await history.recordToken(token("a"));
      for (let i = 0; i < 5; i += 1) await history.recordTrade(tradeAt((T0 + i) * 1000, { priceSol: i + 1 }));

      const chart = await history.tokenChart("a", 1, 2);

      expect(chart?.candles.map((c) => c.close)).toEqual([4, 5]);
    });

    it("lists the creator's trades oldest first as dev trades", async () => {
      const history = await open();
      await history.recordToken(token("a", { creator: "dev" }));
      const base = T0 * 1000;
      await history.recordTrade(tradeAt(base + 61_500, { trader: "dev", side: "sell", solAmount: 1.5 }));
      await history.recordTrade(tradeAt(base + 1_000, { trader: "dev", side: "buy", solAmount: 0.5 }));
      await history.recordTrade(tradeAt(base + 2_000, { trader: "fan", side: "buy", solAmount: 3 }));
      await history.recordTrade(tradeAt(base + 3_000, { mint: "b", trader: "dev", side: "buy", solAmount: 9 }));

      const chart = await history.tokenChart("a", 60, 300);

      expect(chart?.devTrades).toEqual([
        { at: new Date(base + 1_000), side: "buy", solAmount: 0.5 },
        { at: new Date(base + 61_500), side: "sell", solAmount: 1.5 },
      ]);
    });
  });
});

describe("PostgresHistory", () => {
  beforeAll(() => postgresAdapter.setup(), 120_000);
  afterAll(() => postgresAdapter.teardown(), 60_000);

  it("migrates idempotently and keeps data across reconnects", async () => {
    const admin = new pg.Client(postgresAdapter.databaseUrl("postgres"));
    await admin.connect();
    await admin.query("CREATE DATABASE reconnect");
    await admin.end();

    const first = await PostgresHistory.connect(postgresAdapter.databaseUrl("reconnect"));
    await first.recordToken(token("a"));
    await first.close();

    const second = await PostgresHistory.connect(postgresAdapter.databaseUrl("reconnect"));
    await second.recordToken(token("a"));

    expect(await second.query("SELECT mint, detected_at FROM tokens")).toEqual([
      { mint: "a", detected_at: String(new Date("2026-11-13T20:00:00.000Z").getTime()) },
    ]);
    await second.close();
  });

  it("rejects instead of throwing when the server is unreachable", async () => {
    const port = await freePort();

    await expect(PostgresHistory.connect(`postgres://postgres:postgres@127.0.0.1:${port}/none`)).rejects.toThrow();
  });
});
