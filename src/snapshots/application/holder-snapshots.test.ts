import { afterEach, describe, expect, it } from "vitest";
import { SqliteHistoryRecorder } from "../../history/infrastructure/sqlite/sqlite-history-recorder.js";
import type { HolderDistributionReader } from "../../safety-checks/domain/holder-distribution-reader.js";
import type { HolderDistribution } from "../../safety-checks/domain/token-safety-snapshot.js";
import type { NewToken } from "../../token-discovery/domain/new-token.js";
import type { TokenSnapshot } from "../domain/assemble-snapshot.js";
import { HolderSnapshots } from "./holder-snapshots.js";

const AT = new Date("2026-11-14T01:00:00.000Z");
const LATER = new Date("2026-11-14T01:00:30.000Z");

const token: NewToken = {
  mint: "a",
  name: "",
  symbol: "A",
  creator: "dev",
  signature: "",
  metadataUri: "",
  bondingCurve: "curve-a",
  pool: "pump",
  initialBuyTokens: 0,
  initialBuySol: 0,
  marketCapSol: 30,
  detectedAt: new Date("2026-11-14T00:00:00.000Z"),
};

const snapshot: TokenSnapshot = {
  mint: "a",
  milestone: "1h",
  at: AT,
  priceSol: 0.0000001,
  marketCapSol: 100,
  volumeSol: 4,
  buys: 3,
  sells: 1,
  uniqueBuyers: 2,
  holders: null,
  top10Pct: null,
  devHoldsPct: null,
  liquidity: { sol: 20, bondingCurvePct: 30, migrated: false },
  source: "trades",
};

const distribution = (totalHolders: number): HolderDistribution => ({
  holders: Array.from({ length: 12 }, (_, i) => ({ owner: `w${i}`, pct: 12 - i, insider: false })),
  creatorPct: 1.234,
  insiderNetworks: 0,
  totalHolders,
});

const stores: SqliteHistoryRecorder[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

const setup = (read: HolderDistributionReader["read"]) => {
  const store = new SqliteHistoryRecorder(":memory:");
  stores.push(store);
  const requested: string[] = [];
  const holders = new HolderSnapshots({
    store,
    reader: {
      read: async (t) => {
        requested.push(`${t.mint}:${t.bondingCurve}`);
        return read(t);
      },
    },
    minIntervalMs: 1,
    clock: () => LATER,
  });
  const run = async () => {
    await store.recordToken(token);
    await store.saveSnapshot(snapshot, {});
    holders.request({ token, snapshot, holderThreshold: 0 });
    await holders.idle();
  };
  return { store, holders, requested, run };
};

describe("HolderSnapshots", () => {
  it("adds the RugCheck holders, top 10 and creator share to the snapshot", async () => {
    const { store, requested, run } = setup(async () => distribution(61));

    await run();

    expect(requested).toEqual(["a:curve-a"]);
    expect((await store.tokenSnapshots("a", LATER))?.snapshots).toEqual([
      { ...snapshot, holders: 61, top10Pct: 75, devHoldsPct: 1.23, source: "mixed" },
    ]);
    expect((await store.listTokens(listQuery)).tokens[0]?.holders).toBe(61);
  });

  it("takes one event snapshot per holder milestone crossed, once", async () => {
    const { store, holders, run } = setup(async () => distribution(612));

    await run();
    holders.request({ token, snapshot, holderThreshold: 500 });
    await holders.idle();

    const snapshots = (await store.tokenSnapshots("a", LATER))?.snapshots ?? [];
    expect(snapshots.map((s) => [s.milestone, s.at, s.holders])).toEqual([
      ["1h", AT, 612],
      ["event:holders-100", LATER, 612],
      ["event:holders-500", LATER, 612],
    ]);
    expect(snapshots[1]).toMatchObject({
      priceSol: 0.0000001,
      liquidity: snapshot.liquidity,
      volumeSol: null,
      buys: null,
      source: "mixed",
    });
    expect((await store.dueTokens(LATER, 1))[0]?.market.holderThreshold).toBe(500);
  });

  it("leaves the snapshot unchanged when RugCheck has no data or fails", async () => {
    const empty = setup(async () => null);
    await empty.run();
    const failing = setup(async () => {
      throw new Error("RugCheck responded 429");
    });
    await failing.run();

    expect((await empty.store.tokenSnapshots("a", LATER))?.snapshots[0]?.holders).toBeNull();
    expect((await failing.store.tokenSnapshots("a", LATER))?.snapshots[0]?.holders).toBeNull();
  });
});

const listQuery = {
  from: null,
  to: null,
  statuses: [],
  lifecycle: null,
  minScore: null,
  search: null,
  sort: { field: "detectedAt" as const, direction: "desc" as const },
  page: 1,
  pageSize: 50,
  now: LATER,
};
