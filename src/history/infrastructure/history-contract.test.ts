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
import type { WalletRecord } from "../../wallet-reputation/domain/reputation-rules.js";
import type {
  SmartWalletEntry,
  TokenClose,
  WalletReputationStore,
} from "../../wallet-reputation/domain/wallet-reputation-store.js";
import type { SessionStore } from "../../auth/domain/session-store.js";
import type { Session } from "../../auth/domain/user.js";
import type { NewUser, UserStore } from "../../auth/domain/user-store.js";
import { advanceCycle, DEFAULT_CYCLE_RULES, startCycle, summarizeCycle, tradePoints } from "../../token-cycle/domain/token-cycle.js";
import type { TokenCycleStore } from "../../token-cycle/domain/token-cycle-store.js";
import { PostgresHistory } from "./postgres/postgres-history.js";
import { SqliteHistoryRecorder } from "./sqlite/sqlite-history-recorder.js";

type History = HistoryRecorder &
  HistoryReader &
  SnapshotStore &
  TokenCatalogReader &
  WalletReputationStore &
  UserStore &
  SessionStore &
  TokenCycleStore;

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
        smartWallets: { count: 0, elite: 0, holding: 0, conviction: 0 },
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
        smartWallets: { count: 0, elite: 0, holding: 0, conviction: 0 },
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
      minSmartWallets: 0,
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
          smartWallets: { count: 0, elite: 0, holding: 0, conviction: 0 },
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
  describe("wallet reputation and smart wallets", () => {
    const NOW = new Date("2026-11-16T12:00:00.000Z");
    const HOUR = 3_600_000;
    const DAY = 24 * HOUR;
    const LOOKBACK = 7 * DAY;
    const ago = (ms: number) => new Date(NOW.getTime() - ms);
    const listQuery = (overrides: Partial<TokenListQuery> = {}): TokenListQuery => ({
      from: null,
      to: null,
      statuses: [],
      lifecycle: null,
      minScore: null,
      minSmartWallets: 0,
      search: null,
      sort: { field: "detectedAt", direction: "desc" },
      page: 1,
      pageSize: 50,
      now: NOW,
      ...overrides,
    });
    const result = (wallet: string, pnlSol: number, closedAt: Date) => ({
      wallet,
      firstBuyAt: new Date(closedAt.getTime() - 50 * 60_000),
      firstSellAt: null as Date | null,
      entrySeconds: 600,
      boughtSol: 1,
      soldSol: 1 + pnlSol,
      pnlSol,
      closedAt,
    });
    const entry = (wallet: string, overrides: Partial<SmartWalletEntry> = {}): SmartWalletEntry => ({
      wallet,
      tierAtEntry: "good",
      styleAtEntry: "conviction",
      firstBuyAt: ago(30 * 60_000),
      entrySeconds: 12.5,
      boughtSol: 1.25,
      soldSol: 0.5,
      stillHolding: true,
      ...overrides,
    });
    const close = (mint: string, overrides: Partial<TokenClose> = {}): TokenClose => ({
      mint,
      detectedAt: ago(2 * HOUR),
      closedAt: ago(HOUR),
      results: [],
      smartWallets: [],
      outcome: null,
      ...overrides,
    });
    const record = (address: string, overrides: Partial<WalletRecord> = {}): WalletRecord => ({
      address,
      tier: "good",
      isBot: false,
      tokens: 6,
      wins: 4,
      winRate: 66.67,
      netPnlSol: 5.5,
      avgPnlSol: 0.916666667,
      medianEntrySeconds: 10,
      style: "conviction",
      flipRate: 0,
      medianHoldSeconds: 120,
      lastActiveAt: ago(HOUR),
      updatedAt: ago(10 * 60_000),
      ...overrides,
    });

    it("rates each wallet at its own buy from results closed before it, within 7 days (no look-ahead)", async () => {
      const history = await open();
      const buyAt = ago(DAY);
      const justBefore = new Date(buyAt.getTime() - 1);
      const weekBefore = new Date(buyAt.getTime() - LOOKBACK);
      await history.saveTokenClose(close("m1", { closedAt: justBefore, results: [result("w1", 2, justBefore)] }));
      await history.saveTokenClose(close("m2", { closedAt: weekBefore, results: [result("w1", -0.5, weekBefore)] }));
      // Ignored: closed at the buy, after it (look-ahead), too old, or the token being rated.
      await history.saveTokenClose(close("m3", { closedAt: buyAt, results: [result("w1", 100, buyAt)] }));
      await history.saveTokenClose(
        close("m4", { closedAt: ago(HOUR), results: [result("w1", 100, ago(HOUR)), result("w2", 100, ago(HOUR))] }),
      );
      const tooOld = new Date(buyAt.getTime() - LOOKBACK - 1);
      await history.saveTokenClose(close("m5", { closedAt: tooOld, results: [result("w1", 100, tooOld)] }));
      const rated = new Date(buyAt.getTime() - HOUR);
      await history.saveTokenClose(close("self", { closedAt: rated, results: [result("w1", 100, rated)] }));

      const stats = await history.statsAtBuys(
        [
          { wallet: "w1", at: buyAt },
          { wallet: "w2", at: buyAt },
          { wallet: "w3", at: NOW },
        ],
        LOOKBACK,
        "self",
      );

      expect([...stats.entries()]).toEqual([["w1", { tokens: 2, wins: 1, netPnlSol: 1.5, flips: 0 }]]);
      expect([...(await history.statsAtBuys([{ wallet: "w2", at: NOW }], LOOKBACK, "x")).entries()]).toEqual([
        ["w2", { tokens: 1, wins: 1, netPnlSol: 100, flips: 0 }],
      ]);
    });

    it("stores a token close once, replacing live smart wallets, and never offers it to close again", async () => {
      const history = await open();
      await history.recordToken(token("a", { detectedAt: ago(3 * HOUR) }));
      await history.recordToken(token("b", { detectedAt: ago(2 * HOUR) }));
      await history.recordToken(token("c", { detectedAt: ago(10 * 60_000) }));
      await history.saveSmartWallet("a", entry("live-only"));
      const closing = close("a", {
        detectedAt: ago(3 * HOUR),
        closedAt: ago(2 * HOUR),
        results: [result("w1", 1.5, ago(2 * HOUR)), result("w2", -1, ago(2 * HOUR))],
        smartWallets: [entry("w1", { tierAtEntry: "elite", stillHolding: false })],
        outcome: { smartWallets: 1, entryAt: ago(170 * 60_000), entryPriceSol: 0.00000003, returnPct: 97, reached2x: true, peakX: 4.5 },
      });

      expect((await history.closableTokens(null, ago(HOUR), 10)).map((t) => t.mint)).toEqual(["a", "b"]);
      await history.saveTokenClose(closing);
      await history.saveTokenClose(closing);

      expect(await countOf("wallet_token_results")).toBe(2);
      expect(await countOf("token_closures")).toBe(1);
      expect(await countOf("smart_wallet_outcomes")).toBe(1);
      expect(await history.tokenSmartWallets("a")).toEqual([entry("w1", { tierAtEntry: "elite", stillHolding: false })]);
      expect((await history.listTokens(listQuery())).tokens.find((t) => t.token.mint === "a")?.smartWallets).toEqual({
        count: 1,
        elite: 1,
        holding: 0,
        conviction: 1,
      });
      expect(await history.closableTokens(null, ago(HOUR), 10)).toEqual([{ mint: "b", creator: "dev", detectedAt: ago(2 * HOUR) }]);
      expect(await history.closableTokens(ago(HOUR), NOW, 10)).toEqual([{ mint: "c", creator: "dev", detectedAt: ago(10 * 60_000) }]);
      expect(await history.walletResults(["w1", "w2", "w9"], ago(DAY))).toEqual([
        { mint: "a", symbol: "A", name: "Name a", ...result("w1", 1.5, ago(2 * HOUR)) },
        { mint: "a", symbol: "A", name: "Name a", ...result("w2", -1, ago(2 * HOUR)) },
      ]);
      expect(await history.walletResults(["w1"], ago(HOUR))).toEqual([]);
      expect(await history.hasWalletResults("w1")).toBe(true);
      expect(await history.hasWalletResults("w9")).toBe(false);
    });

    it("reads a token's trades oldest first, ties in insertion order, and its first safety check", async () => {
      const history = await open();
      await history.recordTrade({ ...trade, signature: "t2", trader: "late", timestamp: ago(HOUR) });
      await history.recordTrade({ ...trade, signature: "t1", trader: "first", side: "sell", timestamp: ago(2 * HOUR) });
      await history.recordTrade({ ...trade, signature: "t3", trader: "second", timestamp: ago(2 * HOUR) });
      await history.recordScreening(failed("a"), ago(30 * 60_000));
      await history.recordScreening(failed("a"), ago(90 * 60_000));

      expect(await history.tokenTrades("a")).toEqual([
        { trader: "first", side: "sell", solAmount: 0.25, tokenAmount: 9000, priceSol: 0.00003, timestamp: ago(2 * HOUR) },
        { trader: "second", side: "buy", solAmount: 0.25, tokenAmount: 9000, priceSol: 0.00003, timestamp: ago(2 * HOUR) },
        { trader: "late", side: "buy", solAmount: 0.25, tokenAmount: 9000, priceSol: 0.00003, timestamp: ago(HOUR) },
      ]);
      expect(await history.firstScreeningAt("a")).toEqual(ago(90 * 60_000));
      expect(await history.firstScreeningAt("none")).toBeNull();
    });

    it("keeps wallet records, lists smart ones and the stale ones to refresh", async () => {
      const history = await open();
      await history.saveWalletRecords([
        record("good", { netPnlSol: 2 }),
        record("elite", { tier: "elite", netPnlSol: 9, isBot: true, updatedAt: ago(3 * HOUR) }),
        record("none", { tier: "none", tokens: 1, medianEntrySeconds: null, lastActiveAt: null, updatedAt: ago(2 * HOUR) }),
        record("empty", { tier: "none", tokens: 0, updatedAt: ago(5 * HOUR) }),
      ]);
      await history.saveWalletRecords([record("good", { netPnlSol: 3 })]);

      expect(await history.smartWalletRecords(10)).toEqual([
        record("elite", { tier: "elite", netPnlSol: 9, isBot: true, updatedAt: ago(3 * HOUR) }),
        record("good", { netPnlSol: 3 }),
      ]);
      expect(await history.smartWalletRecords(1)).toHaveLength(1);
      expect(await history.staleWallets(ago(HOUR), 10)).toEqual(["elite", "none"]);
      expect(await history.staleWallets(ago(HOUR), 1)).toEqual(["elite"]);
    });

    it("filters and sorts tokens and screenings by smart wallets, counting every match", async () => {
      const history = await open();
      for (const [mint, minutes] of [
        ["a", 30],
        ["b", 20],
        ["c", 10],
      ] as const) {
        await history.recordToken(token(mint, { detectedAt: ago(minutes * 60_000) }));
        await history.recordScreening(failed(mint), ago(minutes * 60_000 - 1000));
      }
      await history.saveSmartWallet("a", entry("w1"));
      await history.saveSmartWallet("a", entry("w2", { tierAtEntry: "elite" }));
      await history.saveSmartWallet("b", entry("w1"));
      await history.saveSmartWallet("b", entry("w1", { stillHolding: false, soldSol: 2 }));

      const all = await history.listTokens(listQuery());
      const atLeastOne = await history.listTokens(listQuery({ minSmartWallets: 1 }));
      const atLeastTwo = await history.listTokens(listQuery({ minSmartWallets: 2 }));
      const sorted = await history.listTokens(listQuery({ sort: { field: "smartWallets", direction: "desc" } }));

      expect(all.tokens.map((t) => [t.token.mint, t.smartWallets])).toEqual([
        ["c", { count: 0, elite: 0, holding: 0, conviction: 0 }],
        ["b", { count: 1, elite: 0, holding: 0, conviction: 1 }],
        ["a", { count: 2, elite: 1, holding: 2, conviction: 2 }],
      ]);
      expect([atLeastOne.tokens.map((t) => t.token.mint), atLeastOne.total]).toEqual([["b", "a"], 2]);
      expect([atLeastTwo.tokens.map((t) => t.token.mint), atLeastTwo.total]).toEqual([["a"], 1]);
      expect(sorted.tokens.map((t) => t.token.mint)).toEqual(["a", "b", "c"]);
      expect((await history.recentScreenings(10)).map((s) => s.mint)).toEqual(["c", "b", "a"]);
      expect((await history.recentScreenings(10, 1)).map((s) => s.mint)).toEqual(["b", "a"]);
      expect((await history.recentScreenings(1, 2)).map((s) => s.mint)).toEqual(["a"]);
      expect((await history.recentScreenings(10)).map((s) => [s.mint, s.smartWallets])).toEqual([
        ["c", { count: 0, elite: 0, holding: 0, conviction: 0 }],
        ["b", { count: 1, elite: 0, holding: 0, conviction: 1 }],
        ["a", { count: 2, elite: 1, holding: 2, conviction: 2 }],
      ]);
      expect((await history.tokenHistory("a"))?.screenings[0]?.smartWallets).toEqual({ count: 2, elite: 1, holding: 2, conviction: 2 });
      expect(await history.tokenSmartSummary("a")).toEqual({ count: 2, elite: 1, holding: 2, conviction: 2 });
      expect(await history.tokenSmartSummary("c")).toEqual({ count: 0, elite: 0, holding: 0, conviction: 0 });
      expect([...(await history.mintsWithSmartWallets(["a", "b", "c", "zz"], 1))].sort()).toEqual(["a", "b"]);
      expect([...(await history.mintsWithSmartWallets(["a", "b"], 2))]).toEqual(["a"]);
    });

    it("returns the outcomes of tokens detected in a range, with their migration known now", async () => {
      const history = await open();
      const outcome = (smartWallets: number, returnPct: number) => ({
        smartWallets,
        entryAt: ago(3 * HOUR),
        entryPriceSol: 0.00000003,
        returnPct,
        reached2x: returnPct >= 97,
        peakX: 1.5,
      });
      await history.recordToken(token("a", { detectedAt: ago(3 * HOUR) }));
      await history.updateMarkets([
        {
          mint: "a",
          lastPriceSol: 1,
          peakPriceSol: 1,
          lastTradeAt: NOW,
          lastActivityAt: NOW,
          liquidity: { sol: 85, bondingCurvePct: 100, migrated: true },
        },
      ]);
      await history.saveTokenClose(close("a", { detectedAt: ago(3 * HOUR), outcome: outcome(2, 97) }));
      await history.saveTokenClose(close("b", { detectedAt: ago(2 * HOUR), outcome: outcome(0, -3) }));
      await history.saveTokenClose(close("c", { detectedAt: ago(DAY), outcome: outcome(0, -50) }));
      await history.saveTokenClose(close("d", { detectedAt: ago(2 * HOUR), outcome: null }));

      expect(await history.smartWalletOutcomes(ago(5 * HOUR), ago(HOUR))).toEqual([
        { smartWallets: 2, returnPct: 97, reached2x: true, peakX: 1.5, migrated: true },
        { smartWallets: 0, returnPct: -3, reached2x: false, peakX: 1.5, migrated: false },
      ]);
    });

    it("counts flips at each buy: first sell at most the flip window after the first buy, never sold = no flip (D7)", async () => {
      const history = await open();
      const buyAt = ago(DAY);
      const before = (mint: string, holdMs: number | null, hoursBefore: number) => {
        const closedAt = new Date(buyAt.getTime() - hoursBefore * HOUR);
        const own = result("w1", 1, closedAt);
        return close(mint, {
          closedAt,
          results: [{ ...own, firstSellAt: holdMs === null ? null : new Date(own.firstBuyAt.getTime() + holdMs) }],
        });
      };
      await history.saveTokenClose(before("m1", 120_000, 1)); // flip (boundary)
      await history.saveTokenClose(before("m2", 120_001, 2)); // held
      await history.saveTokenClose(before("m3", null, 3)); // never sold
      // A flip closed after the buy never counts (look-ahead).
      const after = result("w1", 1, ago(HOUR));
      await history.saveTokenClose(close("m4", { closedAt: ago(HOUR), results: [{ ...after, firstSellAt: after.firstBuyAt }] }));

      const stats = await history.statsAtBuys([{ wallet: "w1", at: buyAt }], LOOKBACK, "x", 120_000);

      expect([...stats.entries()]).toEqual([["w1", { tokens: 3, wins: 3, netPnlSol: 3, flips: 1 }]]);
      expect((await history.statsAtBuys([{ wallet: "w1", at: buyAt }], LOOKBACK, "x", 200_000)).get("w1")?.flips).toBe(2);
      expect((await history.walletResults(["w1"], ago(2 * DAY))).map((r) => r.firstSellAt?.getTime() ?? null)).toEqual([
        after.firstBuyAt.getTime(),
        new Date(buyAt.getTime() - HOUR - 50 * 60_000 + 120_000).getTime(),
        new Date(buyAt.getTime() - 2 * HOUR - 50 * 60_000 + 120_001).getTime(),
        null,
      ]);
    });

    it("filters, sorts and checks visibility by conviction wallets, and keeps conviction outcomes", async () => {
      const history = await open();
      for (const [mint, minutes] of [
        ["a", 30],
        ["b", 20],
        ["c", 10],
      ] as const) {
        await history.recordToken(token(mint, { detectedAt: ago(minutes * 60_000) }));
        await history.recordScreening(failed(mint), ago(minutes * 60_000 - 1000));
      }
      // a: 3 smart wallets, 1 conviction; b: 2 smart wallets, 2 conviction; c: none.
      await history.saveSmartWallet("a", entry("w1"));
      await history.saveSmartWallet("a", entry("w2", { styleAtEntry: "flipper" }));
      await history.saveSmartWallet("a", entry("w3", { styleAtEntry: "mixed" }));
      await history.saveSmartWallet("b", entry("w1"));
      await history.saveSmartWallet("b", entry("w4", { tierAtEntry: "elite" }));

      const two = await history.listTokens(listQuery({ minConvictionWallets: 2 }));
      const both = await history.listTokens(listQuery({ minConvictionWallets: 1, minSmartWallets: 3 }));
      const sorted = await history.listTokens(listQuery({ sort: { field: "convictionWallets", direction: "desc" } }));

      expect([two.tokens.map((t) => t.token.mint), two.total]).toEqual([["b"], 1]);
      expect([both.tokens.map((t) => t.token.mint), both.total]).toEqual([["a"], 1]);
      expect(sorted.tokens.map((t) => [t.token.mint, t.smartWallets])).toEqual([
        ["b", { count: 2, elite: 1, holding: 2, conviction: 2 }],
        ["a", { count: 3, elite: 0, holding: 3, conviction: 1 }],
        ["c", { count: 0, elite: 0, holding: 0, conviction: 0 }],
      ]);
      expect((await history.recentScreenings(10, 0, 1)).map((s) => s.mint)).toEqual(["b", "a"]);
      expect((await history.recentScreenings(10, 0, 2)).map((s) => s.mint)).toEqual(["b"]);
      expect((await history.recentScreenings(10, 3, 1)).map((s) => s.mint)).toEqual(["a"]);
      expect([...(await history.mintsWithConvictionWallets(["a", "b", "c"], 2))]).toEqual(["b"]);
      expect((await history.tokenSmartWallets("a")).map((e) => [e.wallet, e.styleAtEntry])).toEqual([
        ["w1", "conviction"],
        ["w2", "flipper"],
        ["w3", "mixed"],
      ]);

      const outcome = { smartWallets: 1, entryAt: ago(3 * HOUR), entryPriceSol: 0.00000003, returnPct: 97, reached2x: true, peakX: 2 };
      await history.saveTokenClose(close("a", { detectedAt: ago(3 * HOUR), outcome: { ...outcome, smartWallets: 3 }, convictionOutcome: outcome }));
      await history.saveTokenClose(close("a", { detectedAt: ago(3 * HOUR), outcome: { ...outcome, smartWallets: 3 }, convictionOutcome: outcome }));
      expect(await history.convictionOutcomes(ago(5 * HOUR), NOW)).toEqual([
        { smartWallets: 1, returnPct: 97, reached2x: true, peakX: 2, migrated: false },
      ]);
      expect((await history.smartWalletOutcomes(ago(5 * HOUR), NOW)).map((o) => o.smartWallets)).toEqual([3]);
    });

    it("adds the D7 columns to a database closed before them and offers its closed tokens again", async () => {
      const history = await open();
      await history.recordToken(token("a", { detectedAt: ago(3 * HOUR) }));
      await history.recordTrade(trade);
      await history.saveTokenClose(close("a", { detectedAt: ago(3 * HOUR), results: [result("w1", 1, ago(2 * HOUR))] }));
      expect(await history.closableTokens(null, NOW, 10)).toEqual([]);
      await execOnLast(
        [
          "ALTER TABLE token_closures DROP COLUMN version",
          "ALTER TABLE wallet_token_results DROP COLUMN first_sell_at",
          "ALTER TABLE token_smart_wallets DROP COLUMN style_at_entry",
          "DROP INDEX smart_wallet_tokens_conviction",
          "ALTER TABLE smart_wallet_tokens DROP COLUMN conviction",
          "ALTER TABLE wallet_reputation DROP COLUMN style",
          "ALTER TABLE wallet_reputation DROP COLUMN flip_rate",
          "ALTER TABLE wallet_reputation DROP COLUMN median_hold_seconds",
          "DROP TABLE conviction_outcomes",
        ].join("; "),
      );

      const migrated = await reopenLast();
      await reopenLast();
      const again = await reopenLast();

      expect((await again.closableTokens(null, NOW, 10)).map((t) => t.mint)).toEqual(["a"]);
      expect((await again.walletResults(["w1"], ago(DAY))).map((r) => r.firstSellAt)).toEqual([null]);
      expect(await countOf("tokens")).toBe(1);
      expect(await countOf("trades")).toBe(1);
      expect(await countOf("wallet_token_results")).toBe(1);
      expect(migrated).toBeDefined();
    });

    it("creates the new tables on an existing database without touching its data", async () => {
      const history = await open();
      await history.recordToken(token("a"));
      await history.recordTrade(trade);
      await execOnLast(
        "DROP TABLE token_closures; DROP TABLE wallet_token_results; DROP TABLE wallet_reputation; DROP TABLE token_smart_wallets; DROP TABLE smart_wallet_tokens; DROP TABLE smart_wallet_outcomes",
      );

      const migrated = await reopenLast();
      expect((await migrated.closableTokens(null, NOW, 10)).map((t) => t.mint)).toEqual(["a"]);
      await reopenLast();

      expect(await countOf("tokens")).toBe(1);
      expect(await countOf("trades")).toBe(1);
      expect(await countOf("wallet_token_results")).toBe(0);
    });
  });

  describe("token cycles", () => {
    const NOW = new Date("2026-11-13T21:00:00.000Z");
    const T0 = Date.UTC(2026, 10, 13, 20, 0, 0);
    /** A moment `seconds` after 20:00:00. */
    const at = (seconds: number): Date => new Date(T0 + seconds * 1000);
    let signatures = 0;
    const tradeAt = (mint: string, seconds: number, priceSol: number): Trade => ({
      ...trade,
      signature: `cycle-${(signatures += 1)}`,
      mint,
      priceSol,
      timestamp: at(seconds),
    });
    const snapshotAt = (mint: string, milestone: string, seconds: number, priceSol: number | null): TokenSnapshot => ({
      mint,
      milestone,
      at: at(seconds),
      priceSol,
      marketCapSol: null,
      volumeSol: null,
      buys: null,
      sells: null,
      uniqueBuyers: null,
      holders: null,
      top10Pct: null,
      devHoldsPct: null,
      liquidity: { sol: null, bondingCurvePct: null, migrated: false },
      source: "dexscreener",
    });
    const wallet = (name: string, seconds: number, styleAtEntry: SmartWalletEntry["styleAtEntry"] = "conviction"): SmartWalletEntry => ({
      wallet: name,
      tierAtEntry: "good",
      styleAtEntry,
      firstBuyAt: at(seconds),
      entrySeconds: seconds,
      boughtSol: 1,
      soldSol: 0,
      stillHolding: true,
    });
    /** A cycle that appeared 100 s in, after these `[seconds, price]` trades. */
    const stateAfter = (...points: [number, number][]) =>
      advanceCycle(startCycle(at(100)), tradePoints(points.map(([seconds, priceSol]) => ({ at: at(seconds), priceSol }))), DEFAULT_CYCLE_RULES);
    const CRASHED = stateAfter([0, 1], [100, 1.6], [130, 1.8], [200, 3.2], [300, 6.4], [330, 3.2]);
    const listQuery = (overrides: Partial<TokenListQuery> = {}): TokenListQuery => ({
      from: null,
      to: null,
      statuses: [],
      lifecycle: null,
      minScore: null,
      minSmartWallets: 0,
      search: null,
      sort: { field: "detectedAt", direction: "desc" },
      page: 1,
      pageSize: 50,
      now: NOW,
      ...overrides,
    });

    it("stores when a token appeared once and never changes it", async () => {
      const history = await open();
      await history.recordToken(token("a"));

      const first = await history.createCycle("a", at(100), NOW);
      const second = await history.createCycle("a", at(500), new Date(NOW.getTime() + 1000));
      await history.saveCycle("a", { ...CRASHED, appearedAt: at(900) }, true, NOW);

      expect(first).toEqual({ created: true, cycle: { state: startCycle(at(100)), caughtUp: false, updatedAt: NOW } });
      expect(second).toEqual({ created: false, cycle: first.cycle });
      expect((await history.tokenCycle("a"))?.state.appearedAt).toEqual(at(100));
      expect(await history.tokenCycle("ghost")).toBeNull();
    });

    it("keeps the whole cycle, to continue it after a restart", async () => {
      const history = await open();
      await history.createCycle("a", at(100), NOW);
      const state = { ...CRASHED, snapshotCursorAt: at(4000) };
      const later = new Date(NOW.getTime() + 5000);

      await history.saveCycle("a", state, true, later);

      expect(await history.tokenCycle("a")).toEqual({ state, caughtUp: true, updatedAt: later });
      const reopened = await reopenLast();
      expect(await reopened.tokenCycle("a")).toEqual({ state, caughtUp: true, updatedAt: later });
      // Folding the stored cycle again gives the same cycle as before the restart.
      const more = tradePoints([{ at: at(400), priceSol: 1.6 }]);
      expect(advanceCycle((await reopened.tokenCycle("a"))!.state, more, DEFAULT_CYCLE_RULES)).toEqual(advanceCycle(state, more, DEFAULT_CYCLE_RULES));
    });

    it("finds when a token appeared: the first buy of the conviction wallet that reached the minimum", async () => {
      const history = await open();
      await history.saveSmartWallet("a", wallet("w1", 40));
      await history.saveSmartWallet("a", wallet("flipper", 50, "flipper"));
      await history.saveSmartWallet("a", wallet("w3", 90));
      await history.saveSmartWallet("a", wallet("w2", 70));
      await history.saveSmartWallet("b", wallet("w1", 10));

      expect(await history.appearanceAt("a", 1)).toEqual(at(40));
      expect(await history.appearanceAt("a", 2)).toEqual(at(70));
      expect(await history.appearanceAt("a", 3)).toEqual(at(90));
      expect(await history.appearanceAt("a", 4)).toBeNull();
      expect(await history.appearanceAt("ghost", 1)).toBeNull();
    });

    it("reads the token of a cycle, or null when it was never stored", async () => {
      const history = await open();
      await history.recordToken(token("a", { creator: "maker", detectedAt: at(5) }));

      expect(await history.cycleToken("a")).toEqual({ mint: "a", creator: "maker", detectedAt: at(5) });
      expect(await history.cycleToken("ghost")).toBeNull();
    });

    it("reads the trades after a cursor oldest first, numbered in insertion order inside a second", async () => {
      const history = await open();
      await history.recordTrade(tradeAt("a", 61, 4));
      for (const priceSol of [1, 2, 3]) await history.recordTrade(tradeAt("a", 60, priceSol));
      await history.recordTrade(tradeAt("b", 60, 99));
      const point = (seconds: number, priceSol: number, ordinal: number) => ({ kind: "trade", at: at(seconds), priceSol, ordinal });

      expect(await history.cycleTrades("a", null, 10)).toEqual([point(60, 1, 0), point(60, 2, 1), point(60, 3, 2), point(61, 4, 0)]);
      expect(await history.cycleTrades("a", null, 2)).toEqual([point(60, 1, 0), point(60, 2, 1)]);
      expect(await history.cycleTrades("a", { at: at(60), count: 2 }, 10)).toEqual([point(60, 3, 2), point(61, 4, 0)]);
      expect(await history.cycleTrades("a", { at: at(61), count: 1 }, 10)).toEqual([]);

      // A trade stored later with the cursor's timestamp is still read, after the ones already folded.
      await history.recordTrade(tradeAt("a", 60, 5));
      expect(await history.cycleTrades("a", { at: at(60), count: 3 }, 10)).toEqual([point(60, 5, 3), point(61, 4, 0)]);
    });

    it("folds a token's stored trades batch by batch into the same cycle as all at once", async () => {
      const history = await open();
      const prices: [number, number][] = [[0, 1], [100, 1.6], [130, 1.8], [200, 3.2], [200, 4], [200, 6.4], [330, 3.2], [400, 1.6]];
      for (const [seconds, priceSol] of prices) await history.recordTrade(tradeAt("a", seconds, priceSol));

      let state = startCycle(at(100));
      for (;;) {
        const batch = await history.cycleTrades("a", state.tradeCursor, 2);
        if (batch.length === 0) break;
        state = advanceCycle(state, batch, DEFAULT_CYCLE_RULES);
      }

      expect(state).toEqual(advanceCycle(startCycle(at(100)), await history.cycleTrades("a", null, 100), DEFAULT_CYCLE_RULES));
      expect(summarizeCycle(state, NOW)).toMatchObject({ phase: "crashed", explosionAt: at(200), peakX: 4, crashAt: at(330), investWindowSeconds: 30 });
    });

    it("reads the snapshot prices after a moment, oldest first, one per moment, skipping unpriced ones", async () => {
      const history = await open();
      await history.recordToken(token("a"));
      await history.saveSnapshot(snapshotAt("a", "d2", 7000, 9), {});
      await history.saveSnapshot(snapshotAt("a", "1h", 3600, 5), {});
      await history.saveSnapshot(snapshotAt("a", "event:migrated", 3600, 5), {});
      await history.saveSnapshot(snapshotAt("a", "2h", 5000, null), {});
      await history.saveSnapshot(snapshotAt("b", "1h", 3600, 77), {});

      expect(await history.cycleSnapshots("a", null, 10)).toEqual([
        { kind: "snapshot", at: at(3600), priceSol: 5 },
        { kind: "snapshot", at: at(7000), priceSol: 9 },
      ]);
      expect(await history.cycleSnapshots("a", at(3600), 10)).toEqual([{ kind: "snapshot", at: at(7000), priceSol: 9 }]);
      expect(await history.cycleSnapshots("a", null, 1)).toEqual([{ kind: "snapshot", at: at(3600), priceSol: 5 }]);
    });

    it("lists the public tokens without a caught-up cycle, newest first, page by page", async () => {
      const history = await open();
      const detected = { old: at(-3000), mid: at(-2000), new: at(-1000) };
      await history.recordToken(token("a", { detectedAt: detected.old }));
      await history.recordToken(token("b", { detectedAt: detected.mid }));
      await history.recordToken(token("c", { detectedAt: detected.mid }));
      await history.recordToken(token("d", { detectedAt: detected.new, creator: "maker" }));
      await history.recordToken(token("e", { detectedAt: detected.new }));
      await history.recordToken(token("f", { detectedAt: detected.new }));
      for (const mint of ["a", "b", "c", "d", "e"]) {
        await history.saveSmartWallet(mint, wallet("w1", 10));
        await history.saveSmartWallet(mint, wallet("w2", 20));
      }
      // "f" has one conviction wallet only; "e" already has a caught-up cycle; "b" has one still catching up.
      await history.saveSmartWallet("f", wallet("w1", 10));
      await history.createCycle("e", at(20), NOW);
      await history.saveCycle("e", startCycle(at(20)), true, NOW);
      await history.createCycle("b", at(20), NOW);

      const all = await history.tokensMissingCycle(2, null, 10);
      expect(all).toEqual([
        { mint: "d", creator: "maker", detectedAt: detected.new },
        { mint: "b", creator: "dev", detectedAt: detected.mid },
        { mint: "c", creator: "dev", detectedAt: detected.mid },
        { mint: "a", creator: "dev", detectedAt: detected.old },
      ]);
      const firstPage = await history.tokensMissingCycle(2, null, 2);
      expect(firstPage.map((t) => t.mint)).toEqual(["d", "b"]);
      expect((await history.tokensMissingCycle(2, firstPage[1]!, 2)).map((t) => t.mint)).toEqual(["c", "a"]);
      expect(await history.tokensMissingCycle(2, all[3]!, 2)).toEqual([]);
      expect((await history.tokensMissingCycle(1, null, 10)).map((t) => t.mint)).toEqual(["d", "f", "b", "c", "a"]);
      expect(await history.tokensMissingCycle(3, null, 10)).toEqual([]);
    });

    it("lists the cycles of tokens detected after a moment, most recently appeared first", async () => {
      const history = await open();
      await history.recordToken(token("a", { detectedAt: at(0) }));
      await history.recordToken(token("b", { detectedAt: at(50), creator: "maker" }));
      await history.recordToken(token("c", { detectedAt: at(-100) }));
      await history.createCycle("a", at(300), NOW);
      await history.createCycle("b", at(200), NOW);
      await history.createCycle("c", at(400), NOW);
      await history.createCycle("unstored", at(500), NOW);

      expect(await history.recentCycles(at(-1), 10)).toEqual([
        { mint: "a", creator: "dev", detectedAt: at(0), appearedAt: at(300) },
        { mint: "b", creator: "maker", detectedAt: at(50), appearedAt: at(200) },
      ]);
      expect((await history.recentCycles(at(-200), 2)).map((c) => c.mint)).toEqual(["c", "a"]);
      expect(await history.recentCycles(at(50), 10)).toEqual([]);
    });

    it("returns what the analysis needs of the cycles that appeared in a range", async () => {
      const history = await open();
      const late = stateAfter([0, 1], [40, 2], [100, 2.4]);
      for (const [mint, appeared] of [["a", 100], ["b", 100], ["c", 100], ["d", 100]] as const) await history.createCycle(mint, at(appeared), NOW);
      await history.saveCycle("a", CRASHED, true, NOW);
      await history.saveCycle("b", late, true, NOW);
      await history.createCycle("early", at(99), NOW);
      await history.createCycle("after", at(200), NOW);

      const samples = await history.cycleSamples(at(100), at(200));

      expect(samples).toEqual([
        { appearedAt: at(100), appearedLate: false, explosionAt: at(200), investWindowSeconds: 30, peakAt: at(300), peakX: 4, crashAt: at(330) },
        { appearedAt: at(100), appearedLate: true, explosionAt: null, investWindowSeconds: -60, peakAt: null, peakX: null, crashAt: null },
        { appearedAt: at(100), appearedLate: false, explosionAt: null, investWindowSeconds: null, peakAt: null, peakX: null, crashAt: null },
        { appearedAt: at(100), appearedLate: false, explosionAt: null, investWindowSeconds: null, peakAt: null, peakX: null, crashAt: null },
      ]);
      expect(await history.cycleSamples(at(500), at(600))).toEqual([]);
    });

    it("lists tokens with their cycle, filtered by phase and lateness and sorted by appearance or window", async () => {
      const history = await open();
      const exploding = stateAfter([0, 1], [100, 1.6], [180, 1.7], [200, 3.2]);
      const late = stateAfter([0, 1], [40, 2], [100, 2.4]);
      for (const [index, mint] of ["a", "b", "c", "d", "e"].entries()) await history.recordToken(token(mint, { detectedAt: at(-index) }));
      await history.createCycle("a", at(100), NOW);
      await history.saveCycle("a", CRASHED, true, NOW);
      await history.createCycle("b", at(100), NOW);
      await history.saveCycle("b", exploding, true, NOW);
      await history.createCycle("c", at(100), NOW);
      await history.saveCycle("c", late, true, NOW);
      await history.createCycle("d", at(250), NOW);
      const mints = async (overrides: Partial<TokenListQuery>) => (await history.listTokens(listQuery(overrides))).tokens.map((entry) => entry.token.mint);

      const { tokens, total } = await history.listTokens(listQuery());
      expect(total).toBe(5);
      expect(tokens.map((entry) => entry.cycle ?? null)).toEqual([
        summarizeCycle(CRASHED, NOW),
        summarizeCycle(exploding, NOW),
        summarizeCycle(late, NOW),
        summarizeCycle(startCycle(at(250)), NOW),
        null,
      ]);
      expect(await mints({ phases: ["crashed"] })).toEqual(["a"]);
      expect(await mints({ phases: ["exploding", "stable"] })).toEqual(["b", "c", "d"]);
      expect(await mints({ appearedLate: true })).toEqual(["c"]);
      expect(await mints({ appearedLate: false })).toEqual(["a", "b", "d"]);
      expect(await mints({ phases: ["stable"], appearedLate: false })).toEqual(["d"]);
      expect((await history.listTokens(listQuery({ phases: ["stable"] }))).total).toBe(2);
      // Tokens without a cycle, or without a window yet, come last.
      expect(await mints({ sort: { field: "appearedAt", direction: "desc" } })).toEqual(["d", "a", "b", "c", "e"]);
      expect(await mints({ sort: { field: "appearedAt", direction: "asc" } })).toEqual(["a", "b", "c", "d", "e"]);
      expect(await mints({ sort: { field: "investWindow", direction: "desc" } })).toEqual(["b", "a", "c", "d", "e"]);
      expect(await mints({ sort: { field: "investWindow", direction: "asc" } })).toEqual(["c", "a", "b", "d", "e"]);
    });

    it("creates the cycle table on an existing database without touching its data", async () => {
      const history = await open();
      await history.recordToken(token("a"));
      await history.recordTrade(trade);
      await history.recordScreening(failed("a"), NOW);
      await history.saveSmartWallet("a", wallet("w1", 10));
      const dump = async (store: History) => ({
        tokens: await store.listTokens(listQuery()),
        trades: await store.tokenTrades("a"),
        screenings: await store.recentScreenings(10),
        smartWallets: await store.tokenSmartWallets("a"),
      });
      const before = await dump(history);
      await execOnLast("DROP TABLE token_cycles");

      const migrated = await reopenLast();
      expect(await dump(migrated)).toEqual(before);
      await migrated.createCycle("a", at(100), NOW);
      const again = await reopenLast();

      expect(await again.tokenCycle("a")).toMatchObject({ caughtUp: false, state: { appearedAt: at(100) } });
      expect(await again.tokenTrades("a")).toEqual(before.trades);
      expect(await countOf("tokens")).toBe(1);
      expect(await countOf("trades")).toBe(1);
      expect(await countOf("token_cycles")).toBe(1);
    });
  });

  describe("users and sessions", () => {
    const AT = new Date("2026-11-17T10:00:00.000Z");
    const LATER = new Date("2026-11-17T11:00:00.000Z");
    const DAY = 24 * 60 * 60_000;
    const newUser = (id: string, username: string): NewUser => ({
      id,
      username,
      passwordHash: `scrypt$hash-of-${id}`,
      role: "superadmin",
      createdAt: AT,
    });
    const session = (tokenHash: string, userId: string, expiresAt = new Date(AT.getTime() + 7 * DAY)): Session => ({
      tokenHash,
      userId,
      createdAt: AT,
      lastSeenAt: AT,
      expiresAt,
    });

    it("creates a user once per username, case-insensitively, and finds it by any case or by id", async () => {
      const history = await open();

      expect(await history.createUser(newUser("u1", "SuperAdmin"))).toBe(true);
      expect(await history.createUser(newUser("u2", "superadmin"))).toBe(false);
      expect(await history.createUser(newUser("u3", "SUPERADMIN"))).toBe(false);
      expect(await history.createUser(newUser("u4", "other"))).toBe(true);

      const stored = {
        id: "u1",
        username: "SuperAdmin",
        passwordHash: "scrypt$hash-of-u1",
        role: "superadmin",
        createdAt: AT,
        updatedAt: AT,
      };
      expect(await history.findUserByUsername("superadmin")).toEqual(stored);
      expect(await history.findUserByUsername("SUPERADMIN")).toEqual(stored);
      expect(await history.findUserById("u1")).toEqual(stored);
      expect(await history.findUserByUsername("nobody")).toBeNull();
      expect(await history.findUserByUsername("super%")).toBeNull();
      expect(await history.findUserById("u2")).toBeNull();
      expect(await countOf("users")).toBe(2);
    });

    it("replaces a password hash and its update time, for that user only", async () => {
      const history = await open();
      await history.createUser(newUser("u1", "superadmin"));
      await history.createUser(newUser("u2", "other"));

      await history.setPasswordHash("u1", "scrypt$new", LATER);

      expect(await history.findUserById("u1")).toMatchObject({ passwordHash: "scrypt$new", createdAt: AT, updatedAt: LATER });
      expect(await history.findUserById("u2")).toMatchObject({ passwordHash: "scrypt$hash-of-u2", updatedAt: AT });
    });

    it("stores a session by token hash with its user, and slides its expiry", async () => {
      const history = await open();
      await history.createUser(newUser("u1", "SuperAdmin"));
      await history.createSession(session("hash-a", "u1"));

      expect(await history.findSession("hash-a")).toEqual({
        ...session("hash-a", "u1"),
        user: { id: "u1", username: "SuperAdmin", role: "superadmin" },
      });
      expect(await history.findSession("hash-b")).toBeNull();

      const expiresAt = new Date(LATER.getTime() + 7 * DAY);
      await history.touchSession("hash-a", LATER, expiresAt);
      await history.touchSession("hash-b", LATER, expiresAt);

      expect(await history.findSession("hash-a")).toMatchObject({ createdAt: AT, lastSeenAt: LATER, expiresAt });
      expect(await countOf("sessions")).toBe(1);
    });

    it("rejects a second session with the same token hash", async () => {
      const history = await open();
      await history.createUser(newUser("u1", "superadmin"));
      await history.createSession(session("hash-a", "u1"));

      await expect(history.createSession(session("hash-a", "u1"))).rejects.toThrow();
    });

    it("deletes one session, or every session of a user except one, returning the deleted hashes", async () => {
      const history = await open();
      await history.createUser(newUser("u1", "superadmin"));
      await history.createUser(newUser("u2", "other"));
      for (const hash of ["a", "b", "c", "d"]) await history.createSession(session(hash, "u1"));
      await history.createSession(session("x", "u2"));

      await history.deleteSession("a");
      await history.deleteSession("missing");
      expect(await history.findSession("a")).toBeNull();

      expect((await history.deleteUserSessions("u1", "c")).sort()).toEqual(["b", "d"]);
      expect(await history.findSession("c")).not.toBeNull();
      expect(await history.findSession("x")).not.toBeNull();
      expect(await history.deleteUserSessions("u1", null)).toEqual(["c"]);
      expect(await history.deleteUserSessions("u1", null)).toEqual([]);
      expect(await countOf("sessions")).toBe(1);
    });

    it("purges expired sessions oldest first, a bounded number per call", async () => {
      const history = await open();
      await history.createUser(newUser("u1", "superadmin"));
      const at = (minutes: number) => new Date(AT.getTime() + minutes * 60_000);
      await history.createSession(session("old-1", "u1", at(1)));
      await history.createSession(session("old-2", "u1", at(2)));
      await history.createSession(session("old-3", "u1", at(3)));
      await history.createSession(session("edge", "u1", at(10)));
      await history.createSession(session("live", "u1", at(11)));

      expect(await history.deleteExpiredSessions(at(10), 2)).toBe(2);
      expect(await history.findSession("old-1")).toBeNull();
      expect(await history.findSession("old-2")).toBeNull();
      expect(await history.findSession("old-3")).not.toBeNull();
      expect(await history.deleteExpiredSessions(at(10), 10)).toBe(2);
      expect(await history.deleteExpiredSessions(at(10), 10)).toBe(0);

      expect(await history.findSession("edge")).toBeNull();
      expect(await history.findSession("live")).not.toBeNull();
    });

    it("adds the tables to an existing database without touching its data, and keeps users across restarts", async () => {
      const history = await open();
      await history.recordToken(token("a"));
      await history.recordTrade(trade);
      await history.recordScreening(failed("a"), AT);
      await execOnLast("DROP TABLE sessions; DROP TABLE users");

      const migrated = await reopenLast();
      expect(await migrated.findUserByUsername("superadmin")).toBeNull();
      await migrated.createUser(newUser("u1", "superadmin"));
      await migrated.createSession(session("hash-a", "u1"));
      const again = await reopenLast();

      expect(await again.findUserByUsername("superadmin")).toMatchObject({ id: "u1" });
      expect(await again.findSession("hash-a")).not.toBeNull();
      expect(await again.createUser(newUser("u2", "SUPERADMIN"))).toBe(false);
      expect(await countOf("tokens")).toBe(1);
      expect(await countOf("trades")).toBe(1);
      expect(await countOf("screenings")).toBe(1);
    });

    it("opens a session only for the password hash that was verified", async () => {
      const history = await open();
      await history.createUser(newUser("u1", "SuperAdmin"));

      expect(await history.createVerifiedSession(session("hash-a", "u1"), "scrypt$hash-of-u1")).toBe(true);
      expect(await history.createVerifiedSession(session("hash-b", "u1"), "scrypt$another")).toBe(false);
      expect(await history.createVerifiedSession(session("hash-c", "nobody"), "scrypt$hash-of-u1")).toBe(false);

      expect(await history.findSession("hash-a")).toEqual({
        ...session("hash-a", "u1"),
        user: { id: "u1", username: "SuperAdmin", role: "superadmin" },
      });
      expect(await history.findSession("hash-b")).toBeNull();
      expect(await history.findSession("hash-c")).toBeNull();
      expect(await countOf("sessions")).toBe(1);
      await expect(history.createVerifiedSession(session("hash-a", "u1"), "scrypt$hash-of-u1")).rejects.toThrow();
    });

    it("replaces a password and ends the user's other sessions at once; the old hash opens no session afterwards", async () => {
      const history = await open();
      await history.createUser(newUser("u1", "superadmin"));
      await history.createUser(newUser("u2", "other"));
      for (const hash of ["a", "b", "c"]) await history.createVerifiedSession(session(hash, "u1"), "scrypt$hash-of-u1");
      await history.createVerifiedSession(session("x", "u2"), "scrypt$hash-of-u2");

      const revoked = await history.replacePassword({
        userId: "u1",
        passwordHash: "scrypt$new",
        updatedAt: LATER,
        expectedPasswordHash: "scrypt$hash-of-u1",
        keepTokenHash: "b",
      });

      expect(revoked?.sort()).toEqual(["a", "c"]);
      expect(await history.findUserById("u1")).toMatchObject({ passwordHash: "scrypt$new", createdAt: AT, updatedAt: LATER });
      expect(await history.findUserById("u2")).toMatchObject({ passwordHash: "scrypt$hash-of-u2", updatedAt: AT });
      expect(await history.findSession("a")).toBeNull();
      expect(await history.findSession("b")).not.toBeNull();
      expect(await history.findSession("c")).toBeNull();
      expect(await history.findSession("x")).not.toBeNull();
      expect(await history.createVerifiedSession(session("late", "u1"), "scrypt$hash-of-u1")).toBe(false);
      expect(await history.findSession("late")).toBeNull();
      expect(await history.createVerifiedSession(session("fresh", "u1"), "scrypt$new")).toBe(true);
      expect(await history.findSession("fresh")).not.toBeNull();
      expect(await countOf("sessions")).toBe(3);
    });

    it("refuses to replace a password that is no longer the expected one, changing nothing", async () => {
      const history = await open();
      await history.createUser(newUser("u1", "superadmin"));
      await history.createVerifiedSession(session("a", "u1"), "scrypt$hash-of-u1");
      await history.createVerifiedSession(session("b", "u1"), "scrypt$hash-of-u1");
      const change = { userId: "u1", passwordHash: "scrypt$new", updatedAt: LATER, keepTokenHash: "a" };

      expect(await history.replacePassword({ ...change, expectedPasswordHash: "scrypt$stale" })).toBeNull();
      expect(await history.replacePassword({ ...change, userId: "nobody", expectedPasswordHash: null })).toBeNull();

      expect(await history.findUserById("u1")).toMatchObject({ passwordHash: "scrypt$hash-of-u1", updatedAt: AT });
      expect(await history.findSession("a")).not.toBeNull();
      expect(await history.findSession("b")).not.toBeNull();

      // Without an expected hash (create-superadmin --reset) it always applies, and keeps no session.
      expect((await history.replacePassword({ ...change, expectedPasswordHash: null, keepTokenHash: null }))?.sort()).toEqual(["a", "b"]);
      expect(await history.findUserById("u1")).toMatchObject({ passwordHash: "scrypt$new", updatedAt: LATER });
      expect(await countOf("sessions")).toBe(0);
    });

    it("never finds a session opened with earlier credentials, even one that was not deleted", async () => {
      const history = await open();
      await history.createUser(newUser("u1", "superadmin"));
      await history.createUser(newUser("u2", "other"));
      await history.createSession(session("a", "u1"));
      await history.createSession(session("x", "u2"));

      await history.setPasswordHash("u1", "scrypt$second", LATER);

      expect(await countOf("sessions")).toBe(2);
      expect(await history.findSession("a")).toBeNull();
      expect(await history.findSession("x")).not.toBeNull();

      // Keeping it through the next password change does not bring it back.
      const revoked = await history.replacePassword({
        userId: "u1",
        passwordHash: "scrypt$third",
        updatedAt: LATER,
        expectedPasswordHash: "scrypt$second",
        keepTokenHash: "a",
      });
      expect(revoked).toEqual([]);
      expect(await history.findSession("a")).toBeNull();
    });

    it("adds credential versions to a database created before them, keeping its users and sessions", async () => {
      const history = await open();
      await history.createUser(newUser("u1", "superadmin"));
      await history.createSession(session("hash-a", "u1"));
      await execOnLast("ALTER TABLE sessions DROP COLUMN credential_version; ALTER TABLE users DROP COLUMN credential_version");

      const migrated = await reopenLast();

      expect(await migrated.findUserByUsername("superadmin")).toMatchObject({ id: "u1", passwordHash: "scrypt$hash-of-u1" });
      expect(await migrated.findSession("hash-a")).not.toBeNull();
      expect(await migrated.createVerifiedSession(session("hash-b", "u1"), "scrypt$hash-of-u1")).toBe(true);
      const revoked = await migrated.replacePassword({
        userId: "u1",
        passwordHash: "scrypt$new",
        updatedAt: LATER,
        expectedPasswordHash: "scrypt$hash-of-u1",
        keepTokenHash: "hash-b",
      });
      expect(revoked).toEqual(["hash-a"]);

      const again = await reopenLast();
      expect(await again.findSession("hash-a")).toBeNull();
      expect(await again.findSession("hash-b")).not.toBeNull();
      expect(await again.createVerifiedSession(session("hash-c", "u1"), "scrypt$hash-of-u1")).toBe(false);
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
