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
import type { SnapshotStore } from "../../snapshots/domain/snapshot-store.js";
import type { TokenSnapshot } from "../../snapshots/domain/assemble-snapshot.js";
import type { HistoryReader } from "../domain/history-reader.js";
import type { HistoryRecorder } from "../domain/history-recorder.js";
import type { TokenCatalogReader, TokenListQuery } from "../domain/token-catalog-reader.js";
import { PostgresHistory } from "./postgres/postgres-history.js";
import { SqliteHistoryRecorder } from "./sqlite/sqlite-history-recorder.js";

type History = HistoryRecorder & HistoryReader & SnapshotStore & TokenCatalogReader;

interface OpenedHistory {
  readonly history: History;
  /** Number of rows stored in a table. */
  count(table: string): Promise<number>;
  /** Runs raw SQL statements. */
  exec(sql: string): Promise<void>;
  /** Closes and opens the same database again, running the migrations once more. */
  reopen(): Promise<OpenedHistory>;
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

const sqliteDirs: string[] = [];
const openSqlite = (path: string): OpenedHistory => {
  const history = new SqliteHistoryRecorder(path);
  return {
    history,
    count: async (table) => Number(history.query(`SELECT COUNT(*) AS n FROM ${table}`)[0]?.["n"]),
    exec: async (sql) => {
      for (const statement of sql.split(";")) if (statement.trim()) history.query(statement);
    },
    reopen: async () => {
      await history.close();
      return openSqlite(path);
    },
    close: () => history.close(),
  };
};

const sqliteAdapter: Adapter = {
  name: "SQLite",
  setup: async () => {},
  open: async () => {
    const dir = mkdtempSync(join(tmpdir(), "lessfomo-contract-"));
    sqliteDirs.push(dir);
    return openSqlite(join(dir, "history.db"));
  },
  teardown: async () => {
    for (const dir of sqliteDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  },
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

      const connect = async (): Promise<OpenedHistory> => {
        const history = await PostgresHistory.connect(databaseUrl(database));
        return {
          history,
          count: async (table) => Number((await history.query(`SELECT COUNT(*) AS n FROM ${table}`))[0]?.["n"]),
          exec: async (sql) => void (await history.query(sql)),
          reopen: async () => {
            await history.close();
            return connect();
          },
          close: () => history.close(),
        };
      };
      return connect();
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
  const execOnLast = async (sql: string): Promise<void> => {
    const store = opened.at(-1);
    if (!store) throw new Error("no history opened");
    await store.exec(sql);
  };
  /** Closes the latest history and opens its database again. */
  const reopenLast = async (): Promise<History> => {
    const store = opened.pop();
    if (!store) throw new Error("no history opened");
    const reopened = await store.reopen();
    opened.push(reopened);
    return reopened.history;
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
        detectedAt: new Date("2026-11-13T20:00:00.000Z"),
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
        detectedAt: new Date("2026-11-13T20:00:00.000Z"),
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
      expect.objectContaining({ mint: "ghost", symbol: "", name: "", detectedAt: null }),
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

  describe("token catalog and snapshots", () => {
    const NOW = new Date("2026-11-14T12:00:00.000Z");
    const HOUR = 3_600_000;
    const ago = (ms: number) => new Date(NOW.getTime() - ms);
    const query = (overrides: Partial<TokenListQuery> = {}): TokenListQuery => ({
      from: null,
      to: null,
      statuses: [],
      lifecycle: null,
      minScore: null,
      search: null,
      sort: { field: "detectedAt", direction: "desc" },
      page: 1,
      pageSize: 50,
      now: NOW,
      ...overrides,
    });
    const mintsOf = async (history: History, overrides: Partial<TokenListQuery> = {}) =>
      (await history.listTokens(query(overrides))).tokens.map((entry) => entry.token.mint);
    const snapshot = (mint: string, milestone: string, at: Date, overrides: Partial<TokenSnapshot> = {}): TokenSnapshot => ({
      mint,
      milestone,
      at,
      priceSol: 0.00000004,
      marketCapSol: 40,
      volumeSol: 3.5,
      buys: 7,
      sells: 2,
      uniqueBuyers: 5,
      holders: null,
      top10Pct: null,
      devHoldsPct: null,
      liquidity: { sol: 12.5, bondingCurvePct: 40.25, migrated: false },
      source: "trades",
      ...overrides,
    });
    const passed = (mint: string, totalHolders: number): ScreeningResult => ({
      token: token(mint),
      status: "passed",
      report: { passed: true, failures: [], metrics: { top10Pct: 12, creatorPct: 1, totalHolders } },
    });

    it("lists every token newest first with its latest state", async () => {
      const history = await open();
      await history.recordToken(token("old", { detectedAt: ago(30 * HOUR) }));
      await history.recordToken(token("new", { detectedAt: ago(HOUR) }));
      await history.recordScreening(passed("new", 61), ago(HOUR));
      await history.recordMomentum(point("new", ago(50 * 60_000).toISOString(), 40));
      await history.recordMomentum(point("new", ago(40 * 60_000).toISOString(), 25));
      await history.updateMarkets([
        {
          mint: "new",
          lastPriceSol: 0.00000005,
          peakPriceSol: 0.00000009,
          lastTradeAt: ago(10 * 60_000),
          lastActivityAt: ago(10 * 60_000),
          liquidity: { sol: 20.5, bondingCurvePct: 60.5, migrated: false },
        },
      ]);
      await history.saveSnapshot(snapshot("new", "0m", ago(HOUR)), {});

      const list = await history.listTokens(query());

      expect(list.total).toBe(2);
      expect(list.tokens).toEqual([
        {
          token: {
            mint: "new",
            symbol: "NEW",
            name: "Name new",
            creator: "dev",
            metadataUri: "https://example.com/meta.json",
            initialBuySol: 0.5,
            marketCapSol: 28,
            detectedAt: ago(HOUR),
          },
          status: "passed",
          lifecycle: "active",
          liquidity: { sol: 20.5, bondingCurvePct: 60.5, migrated: false },
          lastPriceSol: 0.00000005,
          peakPriceSol: 0.00000009,
          maxScore: 40,
          holders: 61,
          lastTradeAt: ago(10 * 60_000),
          snapshotCount: 1,
        },
        expect.objectContaining({
          token: expect.objectContaining({ mint: "old" }),
          status: "pending",
          lifecycle: "dead",
          liquidity: { sol: null, bondingCurvePct: null, migrated: false },
          lastPriceSol: null,
          peakPriceSol: null,
          maxScore: null,
          holders: null,
          lastTradeAt: null,
          snapshotCount: 0,
        }),
      ]);
    });

    it("filters by creation time, status, lifecycle, score and text, counting every match", async () => {
      const history = await open();
      await history.recordToken(token("a", { detectedAt: ago(48 * HOUR), symbol: "CATS", name: "Cat Coin" }));
      await history.recordToken(token("b", { detectedAt: ago(5 * HOUR), symbol: "DOG", name: "Doggo 100%" }));
      await history.recordToken(token("c", { detectedAt: ago(2 * HOUR), symbol: "FROG", name: "Frog" }));
      await history.recordToken(token("Cd9", { detectedAt: ago(HOUR), symbol: "X_Y", name: "Pepe" }));
      await history.recordScreening(failed("a"), ago(47 * HOUR));
      await history.recordScreening(passed("b", 30), ago(5 * HOUR));
      await history.recordScreening({ token: token("c"), status: "unverified", reason: "x" }, ago(2 * HOUR));
      await history.recordMomentum(point("b", ago(4 * HOUR).toISOString(), 70));
      await history.recordMomentum(point("c", ago(HOUR).toISOString(), 30));

      expect(await mintsOf(history, { from: ago(5 * HOUR), to: ago(HOUR) })).toEqual(["c", "b"]);
      expect(await mintsOf(history, { statuses: ["failed", "pending"] })).toEqual(["Cd9", "a"]);
      expect(await mintsOf(history, { lifecycle: "dead" })).toEqual(["a"]);
      expect(await mintsOf(history, { lifecycle: "active" })).toEqual(["Cd9", "c", "b"]);
      expect(await mintsOf(history, { minScore: 30 })).toEqual(["c", "b"]);
      expect(await mintsOf(history, { search: "cat" })).toEqual(["a"]);
      expect(await mintsOf(history, { search: "DOGGO" })).toEqual(["b"]);
      expect(await mintsOf(history, { search: "c" })).toEqual(["Cd9", "c", "a"]);
      expect(await mintsOf(history, { search: "100%" })).toEqual(["b"]);
      expect(await mintsOf(history, { search: "%" })).toEqual(["b"]);
      expect(await mintsOf(history, { search: "x_" })).toEqual(["Cd9"]);
      expect(await mintsOf(history, { search: "_" })).toEqual(["Cd9"]);

      const page = await history.listTokens(query({ page: 2, pageSize: 3 }));
      expect(page.total).toBe(4);
      expect(page.tokens.map((entry) => entry.token.mint)).toEqual(["a"]);
    });

    it("sorts by score, peak market cap or liquidity, unknown values last", async () => {
      const history = await open();
      for (const [index, mint] of ["a", "b", "c"].entries()) {
        await history.recordToken(token(mint, { detectedAt: ago((3 - index) * HOUR) }));
      }
      await history.recordMomentum(point("a", ago(HOUR).toISOString(), 10));
      await history.recordMomentum(point("b", ago(HOUR).toISOString(), 50));
      const market = (mint: string, peak: number, sol: number) => ({
        mint,
        lastPriceSol: null,
        peakPriceSol: peak,
        lastTradeAt: null,
        lastActivityAt: null,
        liquidity: { sol, bondingCurvePct: null, migrated: false },
      });
      await history.updateMarkets([market("a", 0.3, 5), market("c", 0.1, 50)]);

      expect(await mintsOf(history, { sort: { field: "maxScore", direction: "desc" } })).toEqual(["b", "a", "c"]);
      expect(await mintsOf(history, { sort: { field: "maxScore", direction: "asc" } })).toEqual(["a", "b", "c"]);
      expect(await mintsOf(history, { sort: { field: "peakMarketCapSol", direction: "desc" } })).toEqual(["a", "c", "b"]);
      expect(await mintsOf(history, { sort: { field: "liquidity", direction: "asc" } })).toEqual(["a", "c", "b"]);
      expect(await mintsOf(history, { sort: { field: "detectedAt", direction: "asc" } })).toEqual(["a", "b", "c"]);
    });

    it("keeps the highest peak, the latest trade and migration once seen", async () => {
      const history = await open();
      await history.recordToken(token("a", { detectedAt: ago(HOUR) }));
      const update = { mint: "a", lastPriceSol: null, peakPriceSol: null, lastTradeAt: null, lastActivityAt: null };
      await history.updateMarkets([
        { ...update, peakPriceSol: 0.5, lastTradeAt: ago(60_000), liquidity: { sol: 80, bondingCurvePct: 100, migrated: true } },
      ]);
      await history.updateMarkets([
        { ...update, peakPriceSol: 0.2, lastTradeAt: ago(120_000), lastPriceSol: 0.2, liquidity: { sol: null, bondingCurvePct: null, migrated: false } },
      ]);

      const [entry] = (await history.listTokens(query())).tokens;

      expect(entry).toMatchObject({
        peakPriceSol: 0.5,
        lastPriceSol: 0.2,
        lastTradeAt: ago(60_000),
        liquidity: { sol: 80, bondingCurvePct: 100, migrated: true },
      });
    });

    it("schedules the 0m snapshot of a new token at its creation and moves the schedule on save", async () => {
      const history = await open();
      await history.recordToken(token("a", { detectedAt: ago(10 * 60_000), marketCapSol: 30, bondingCurve: "curveA" }));
      await history.recordToken(token("b", { detectedAt: ago(60_000) }));
      await history.recordToken(token("a", { detectedAt: ago(5 * 60_000) }));

      const due = await history.dueTokens(NOW, 10);

      expect(due.map((d) => [d.mint, d.nextMilestone])).toEqual([
        ["a", "0m"],
        ["b", "0m"],
      ]);
      expect(due[0]).toEqual({
        mint: "a",
        symbol: "A",
        creator: "dev",
        bondingCurve: "curveA",
        detectedAt: ago(10 * 60_000),
        creationPriceSol: 0.00000003,
        nextMilestone: "0m",
        lastSnapshotAt: null,
        market: {
          liquidity: { sol: null, bondingCurvePct: null, migrated: false },
          lastPriceSol: null,
          peakPriceSol: null,
          lastTradeAt: null,
          lastActivityAt: null,
          holders: null,
          holderThreshold: 0,
          lastMilestone: null,
          peakEventWindow: null,
        },
      });
      expect((await history.dueTokens(NOW, 1)).map((d) => d.mint)).toEqual(["a"]);
      expect(await history.dueTokens(ago(11 * 60_000), 10)).toEqual([]);

      await history.saveSnapshot(snapshot("a", "10m", ago(1_000)), {
        next: { milestone: "15m", at: new Date(NOW.getTime() + 5 * 60_000) },
        lastMilestone: "10m",
      });
      await history.saveSnapshot(snapshot("a", "event:new-peak", NOW), { peakEventWindow: "10m", holderThreshold: 100 });

      expect((await history.dueTokens(NOW, 10)).map((d) => d.mint)).toEqual(["b"]);
      const later = (await history.dueTokens(new Date(NOW.getTime() + 5 * 60_000), 10)).find((d) => d.mint === "a");
      expect(later).toMatchObject({
        mint: "a",
        nextMilestone: "15m",
        lastSnapshotAt: NOW,
        market: { lastMilestone: "10m", peakEventWindow: "10m", holderThreshold: 100 },
      });
    });

    it("stops the schedule of a dead token and reports it as dead", async () => {
      const history = await open();
      await history.recordToken(token("a", { detectedAt: ago(HOUR) }));

      await history.markDead("a");

      expect(await history.dueTokens(NOW, 10)).toEqual([]);
      expect((await history.listTokens(query())).tokens[0]?.lifecycle).toBe("dead");
      expect((await history.tokenSnapshots("a", NOW))?.lifecycle).toBe("dead");
    });

    it("lists the tokens still on schedule since a time, to watch them after a restart", async () => {
      const history = await open();
      await history.recordToken(token("old", { detectedAt: ago(30 * HOUR) }));
      await history.recordToken(token("a", { detectedAt: ago(2 * HOUR) }));
      await history.recordToken(token("b", { detectedAt: ago(HOUR) }));
      await history.recordToken(token("dead", { detectedAt: ago(HOUR) }));
      await history.markDead("dead");
      await history.updateMarkets([
        { mint: "a", lastPriceSol: 0.1, peakPriceSol: 0.2, lastTradeAt: null, lastActivityAt: null, liquidity: null },
      ]);

      const watched = await history.watchedTokens(ago(24 * HOUR), 10);

      expect(watched.map((w) => w.mint)).toEqual(["b", "a"]);
      expect(watched[1]).toMatchObject({ detectedAt: ago(2 * HOUR), market: { lastPriceSol: 0.1, peakPriceSol: 0.2 } });
      expect((await history.watchedTokens(ago(24 * HOUR), 1)).map((w) => w.mint)).toEqual(["b"]);
    });

    it("aggregates the stored trades of a token between two snapshots", async () => {
      const history = await open();
      const at = (ms: number, overrides: Partial<Trade>): Trade => ({
        ...trade,
        signature: `s${ms}${overrides.trader ?? ""}${overrides.side ?? ""}`,
        timestamp: new Date(ago(HOUR).getTime() + ms),
        ...overrides,
      });
      await history.recordTrade(at(0, { priceSol: 1, solAmount: 1 }));
      await history.recordTrade(at(1_000, { priceSol: 2, solAmount: 2, trader: "x" }));
      await history.recordTrade(at(2_000, { priceSol: 3, solAmount: 0.5, trader: "x" }));
      await history.recordTrade(at(3_000, { priceSol: 4, solAmount: 0.25, side: "sell", trader: "y" }));
      await history.recordTrade(at(9_000, { priceSol: 9, solAmount: 10 }));
      await history.recordTrade(at(2_500, { mint: "other", priceSol: 100, solAmount: 100 }));

      expect(await history.tradeWindow("a", new Date(ago(HOUR).getTime()), new Date(ago(HOUR).getTime() + 3_000))).toEqual({
        lastPriceSol: 4,
        volumeSol: 2.75,
        buys: 2,
        sells: 1,
        uniqueBuyers: 1,
      });
      expect(await history.tradeWindow("a", null, new Date(ago(HOUR).getTime() + 1_000))).toMatchObject({
        lastPriceSol: 2,
        buys: 2,
        uniqueBuyers: 2,
      });
      expect(await history.tradeWindow("a", new Date(ago(HOUR).getTime() + 3_000), new Date(ago(HOUR).getTime() + 5_000))).toEqual({
        lastPriceSol: 4,
        volumeSol: 0,
        buys: 0,
        sells: 0,
        uniqueBuyers: 0,
      });
      expect(await history.tradeWindow("none", null, NOW)).toEqual({
        lastPriceSol: null,
        volumeSol: 0,
        buys: 0,
        sells: 0,
        uniqueBuyers: 0,
      });
    });

    it("returns the snapshots of a token oldest first, once each, with holders added later", async () => {
      const history = await open();
      await history.recordToken(token("a", { detectedAt: ago(2 * HOUR) }));
      await history.saveSnapshot(snapshot("a", "1h", ago(HOUR), { source: "dexscreener", uniqueBuyers: null }), {});
      await history.saveSnapshot(snapshot("a", "0m", ago(2 * HOUR)), {});
      await history.saveSnapshot(snapshot("a", "0m", ago(2 * HOUR), { priceSol: 1 }), {});
      await history.saveSnapshot(
        snapshot("a", "event:migrated", ago(HOUR), { priceSol: null, marketCapSol: null, liquidity: { sol: null, bondingCurvePct: 100, migrated: true } }),
        {},
      );
      await history.addSnapshotHolders("a", "1h", ago(HOUR), { holders: 150, top10Pct: 22.5, devHoldsPct: 1.25 });

      const result = await history.tokenSnapshots("a", NOW);

      expect(result?.lifecycle).toBe("active");
      expect(result?.snapshots).toEqual([
        snapshot("a", "0m", ago(2 * HOUR)),
        snapshot("a", "1h", ago(HOUR), {
          source: "mixed",
          uniqueBuyers: null,
          holders: 150,
          top10Pct: 22.5,
          devHoldsPct: 1.25,
        }),
        snapshot("a", "event:migrated", ago(HOUR), {
          priceSol: null,
          marketCapSol: null,
          liquidity: { sol: null, bondingCurvePct: 100, migrated: true },
        }),
      ]);
      expect((await history.listTokens(query())).tokens[0]).toMatchObject({ holders: 150, snapshotCount: 3 });
      expect(await history.tokenSnapshots("nope", NOW)).toBeNull();
    });

    it("marks holder data on an otherwise empty snapshot as coming from RugCheck", async () => {
      const history = await open();
      await history.recordToken(token("a"));
      const empty = snapshot("a", "2h", ago(HOUR), {
        priceSol: null,
        marketCapSol: null,
        volumeSol: null,
        buys: null,
        sells: null,
        uniqueBuyers: null,
        liquidity: { sol: null, bondingCurvePct: null, migrated: false },
      });
      await history.saveSnapshot(empty, {});
      await history.addSnapshotHolders("a", "2h", ago(HOUR), { holders: 3, top10Pct: 90, devHoldsPct: 50 });

      expect((await history.tokenSnapshots("a", NOW))?.snapshots[0]?.source).toBe("rugcheck");
    });

    it("counts tokens, statuses, trades and snapshots", async () => {
      const history = await open();
      expect(await history.stats(NOW)).toEqual({
        since: null,
        tokens: { total: 0, active: 0, dead: 0, migrated: 0 },
        screenings: { passed: 0, failed: 0, unverified: 0, pending: 0 },
        trades: 0,
        snapshots: 0,
      });

      await history.recordToken(token("a", { detectedAt: ago(30 * HOUR) }));
      await history.recordToken(token("b", { detectedAt: ago(HOUR) }));
      await history.recordToken(token("c", { detectedAt: ago(2 * HOUR) }));
      await history.recordScreening(failed("a"), ago(29 * HOUR));
      await history.recordScreening(passed("b", 40), ago(HOUR));
      await history.recordScreening(failed("b"), ago(HOUR));
      await history.recordTrade(trade);
      await history.updateMarkets([
        { mint: "c", lastPriceSol: null, peakPriceSol: null, lastTradeAt: null, lastActivityAt: null, liquidity: { sol: 85, bondingCurvePct: 100, migrated: true } },
      ]);
      await history.saveSnapshot(snapshot("b", "0m", ago(HOUR)), {});

      expect(await history.stats(NOW)).toEqual({
        since: ago(30 * HOUR),
        tokens: { total: 3, active: 2, dead: 1, migrated: 1 },
        screenings: { passed: 0, failed: 2, unverified: 0, pending: 1 },
        trades: 1,
        snapshots: 1,
      });
    });

    it("migrates a database created before snapshots, keeping and indexing its data", async () => {
      const history = await open();
      await history.recordToken(token("a", { detectedAt: ago(2 * HOUR) }));
      await history.recordToken(token("b", { detectedAt: ago(30 * HOUR) }));
      await history.recordScreening(passed("a", 80), ago(2 * HOUR));
      await history.recordScreening(failed("a"), ago(HOUR));
      await history.recordMomentum(point("a", ago(90 * 60_000).toISOString(), 55));
      await history.recordMomentum(point("a", ago(80 * 60_000).toISOString(), 35));
      await history.recordTrade({ ...trade, signature: "t1", priceSol: 0.4, timestamp: ago(100 * 60_000) });
      await history.recordTrade({ ...trade, signature: "t2", priceSol: 0.2, timestamp: ago(70 * 60_000) });
      // The database as it was before this version: no snapshot tables, no new indexes.
      await execOnLast("DROP TABLE token_state; DROP TABLE token_snapshots; DROP INDEX tokens_detected_at");

      const migrated = await reopenLast();
      const firstList = await migrated.listTokens(query());
      const again = await reopenLast();

      expect(await countOf("tokens")).toBe(2);
      expect(await countOf("trades")).toBe(2);
      expect((await again.listTokens(query())).tokens).toEqual(firstList.tokens);
      expect(firstList.tokens).toEqual([
        expect.objectContaining({
          token: expect.objectContaining({ mint: "a" }),
          status: "failed",
          lifecycle: "active",
          maxScore: 55,
          holders: 3,
          lastPriceSol: 0.2,
          peakPriceSol: 0.4,
          lastTradeAt: ago(70 * 60_000),
        }),
        expect.objectContaining({ token: expect.objectContaining({ mint: "b" }), status: "pending", lifecycle: "dead" }),
      ]);
      expect((await again.dueTokens(NOW, 10)).map((d) => [d.mint, d.nextMilestone])).toEqual([
        ["b", "0m"],
        ["a", "0m"],
      ]);
      expect((await again.recentScreenings(1))[0]?.detectedAt).toEqual(ago(2 * HOUR));
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
