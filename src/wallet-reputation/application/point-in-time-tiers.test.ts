import { afterAll, afterEach, describe, expect, it } from "vitest";
import { TokenVisibility } from "../../api/token-visibility.js";
import { loadAppConfig } from "../../config/app-config.js";
import { SqliteHistoryRecorder } from "../../history/infrastructure/sqlite/sqlite-history-recorder.js";
import { LiveFeed } from "../../live-feed/application/live-feed.js";
import type { Trade } from "../../momentum/domain/trade.js";
import type { NewToken } from "../../token-discovery/domain/new-token.js";
import { DEFAULT_REPUTATION_RULES, statsAt, styleOf, tierOf, type ReputationRules, type WalletStyle, type WalletTier } from "../domain/reputation-rules.js";
import { ReputationCloser } from "./reputation-closer.js";
import { SmartWalletTracker } from "./smart-wallet-tracker.js";

/**
 * Decision D2 (no look-ahead) end to end: closed results use only trades inside the window, and a
 * live buy counts with exactly its point-in-time tier, never a cached current one.
 * Ported from the independent verifier's fixtures (verify-lookahead, verify-stale).
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

let seq = 0;
const tok = (mint: string, at: number, creator = "dev"): NewToken => ({
  mint,
  name: mint,
  symbol: mint,
  creator,
  signature: "s",
  metadataUri: "",
  bondingCurve: "c",
  pool: "pump",
  initialBuyTokens: 0,
  initialBuySol: 0,
  marketCapSol: 30,
  detectedAt: new Date(at),
});
const tr = (mint: string, trader: string, side: "buy" | "sell", at: number, sol: number, tokens: number): Trade => ({
  signature: `s${(seq += 1)}`,
  mint,
  trader,
  side,
  solAmount: sol,
  tokenAmount: tokens,
  priceSol: sol / tokens,
  timestamp: new Date(at),
});

const stores: SqliteHistoryRecorder[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});
const newStore = (): SqliteHistoryRecorder => {
  const store = new SqliteHistoryRecorder(":memory:");
  stores.push(store);
  return store;
};

describe("closed results use only trades before the close (no look-ahead)", () => {
  const T0 = new Date("2026-11-10T12:00:00.000Z").getTime();
  const run = async (store: SqliteHistoryRecorder) => {
    const closer = new ReputationCloser({ store, rules: DEFAULT_REPUTATION_RULES, trackingWindowMs: HOUR, clock: () => new Date(T0 + 48 * HOUR) });
    for (let i = 0; i < 50; i += 1) if (!(await closer.tick()).backlog) break;
  };
  /** Four tokens of `wallet` closing before `base`; from `lossesFrom` on they lose. */
  const resultsBefore = async (store: SqliteHistoryRecorder, wallet: string, base: number, lossesFrom: number | null = null) => {
    for (let i = 0; i < 4; i += 1) {
      const mint = `${wallet}P${i}`;
      const detected = base - (10 - i) * HOUR;
      await store.recordToken(tok(mint, detected));
      await store.recordTrade(tr(mint, wallet, "buy", detected + MIN, 1, 1000));
      await store.recordTrade(tr(mint, wallet, "sell", detected + 2 * MIN, lossesFrom !== null && i >= lossesFrom ? 0.5 : 2, 1000));
    }
  };

  it("tier at entry ignores results closed at or after the buy", async () => {
    const store = newStore();
    await resultsBefore(store, "W", T0);
    await store.recordToken(tok("B", T0 - HOUR)); // closes at T0
    await store.recordTrade(tr("B", "W", "buy", T0 - HOUR + MIN, 1, 1000));
    await store.recordTrade(tr("B", "W", "sell", T0 - HOUR + 2 * MIN, 2, 1000));
    for (const [mint, detected, buy] of [
      ["A", T0 - 30 * MIN, T0 - 1000],
      ["E", T0 - 20 * MIN, T0],
      ["C", T0 - 10 * MIN, T0 + 1000],
    ] as const) {
      await store.recordToken(tok(mint, detected));
      await store.recordTrade(tr(mint, "W", "buy", buy, 1, 1000));
    }

    await run(store);

    expect(store.query("SELECT mint, tier_at_entry FROM token_smart_wallets WHERE wallet='W' ORDER BY mint")).toEqual([
      { mint: "C", tier_at_entry: "good" },
    ]);
  });

  it("a result ignores trades stored after its window ended, valued at the last price before it", async () => {
    const store = newStore();
    await resultsBefore(store, "W2", T0, 2); // 2 wins, 2 losses: B2 decides the tier
    await store.recordToken(tok("B2", T0 - HOUR)); // closed_at = T0
    await store.recordTrade(tr("B2", "W2", "buy", T0 - HOUR + MIN, 1, 1000)); // 0.001 per token
    await store.recordTrade(tr("B2", "X", "sell", T0 - 5 * MIN, 0.1, 1000)); // 0.0001 at the window end: W2 loses
    await store.recordTrade(tr("B2", "Y", "buy", T0 + 20_000, 5, 1000)); // 0.005, 20 s after the close
    await store.recordToken(tok("A2", T0 - 30 * MIN));
    await store.recordTrade(tr("A2", "W2", "buy", T0 + 10_000, 1, 1000)); // 10 s after B2 closed

    await run(store);

    expect(store.query("SELECT pnl_sol FROM wallet_token_results WHERE wallet='W2' AND mint='B2'")).toEqual([{ pnl_sol: -0.9 }]);
    expect(store.query("SELECT wallet FROM wallet_token_results WHERE mint='B2' AND wallet='Y'")).toEqual([]);
    expect(store.query("SELECT tier_at_entry FROM token_smart_wallets WHERE wallet='W2' AND mint='A2'")).toEqual([]);
  });

  it("control: without the post-window trade the same wallet is not smart either", async () => {
    const store = newStore();
    await resultsBefore(store, "W2", T0, 2);
    await store.recordToken(tok("B2", T0 - HOUR));
    await store.recordTrade(tr("B2", "W2", "buy", T0 - HOUR + MIN, 1, 1000));
    await store.recordTrade(tr("B2", "X", "sell", T0 - 5 * MIN, 0.1, 1000));
    await store.recordToken(tok("A2", T0 - 30 * MIN));
    await store.recordTrade(tr("A2", "W2", "buy", T0 + 10_000, 1, 1000));

    await run(store);

    expect(store.query("SELECT tier_at_entry FROM token_smart_wallets WHERE wallet='W2' AND mint='A2'")).toEqual([]);
  });
});

/** The production wiring of the tracker and the closer, on one store. */
const wire = (store: SqliteHistoryRecorder, rules: ReputationRules, window: number, clock: () => Date, closeGraceMs = 30_000) => {
  const feed = new LiveFeed(1);
  const live = new Map<string, Map<string, string>>();
  const tracker = new SmartWalletTracker({
    trackingWindowMs: window,
    rules,
    statsAtBuys: (buys, excludedMint) => store.statsAtBuys(buys, rules.lookbackMs, excludedMint, rules.style.flipWindowMs),
    onChange: (change) => feed.smartWalletChanged(change),
    persist: (mint, entry) => {
      const tiers = live.get(mint) ?? new Map<string, string>();
      tiers.set(entry.wallet, `${entry.tierAtEntry}/${entry.styleAtEntry}`);
      live.set(mint, tiers);
      void store.saveSmartWallet(mint, entry);
    },
  });
  const closer = new ReputationCloser({
    store,
    rules,
    trackingWindowMs: window,
    closeGraceMs,
    clock,
    onRecords: (records) => tracker.updateRecords(records),
    onClosedThrough: (completeThrough, closed) => tracker.rateThrough(completeThrough, closed),
  });
  return { feed, tracker, closer, live };
};

describe("live smart wallets use point-in-time tiers only", () => {
  it("a stale good record never makes a token public live (it is not public after close either)", async () => {
    const store = newStore();
    const U = new Date("2026-11-08T00:00:00Z").getTime();
    // Five wins of W closing about 6.5 days before U.
    for (let i = 0; i < 5; i += 1) {
      const mint = `P${i}`;
      const detected = U - 6.5 * DAY - (i + 2) * HOUR;
      await store.recordToken(tok(mint, detected));
      await store.recordTrade(tr(mint, "W", "buy", detected + MIN, 1, 1000));
      await store.recordTrade(tr(mint, "W", "sell", detected + 2 * MIN, 2, 1000));
    }
    let clock = U;
    const first = new ReputationCloser({ store, rules: DEFAULT_REPUTATION_RULES, trackingWindowMs: HOUR, clock: () => new Date(clock) });
    for (let i = 0; i < 10; i += 1) if (!(await first.tick()).backlog) break;
    expect(store.query("SELECT tier FROM wallet_reputation WHERE wallet='W'")).toEqual([{ tier: "good" }]);

    // One day later, steady state: other tokens keep closing, the process restarts.
    clock = U + DAY;
    for (let i = 0; i < 3; i += 1) {
      const mint = `Z${i}`;
      const detected = clock - HOUR - 2 * MIN + i;
      await store.recordToken(tok(mint, detected));
      await store.recordTrade(tr(mint, "Q", "buy", detected + MIN, 1, 1000));
    }
    const { feed, tracker, closer } = wire(store, DEFAULT_REPUTATION_RULES, HOUR, () => new Date(clock));
    await closer.loadRecords();
    expect(tracker.recordCount()).toBe(0); // the day-old record is not resurrected
    await closer.tick();

    const A = tok("A", clock);
    feed.tokenDetected(A);
    tracker.track(A);
    await store.recordToken(A);
    const buy = tr("A", "W", "buy", clock + MIN, 1, 1000);
    await store.recordTrade(buy);
    tracker.tradeRecorded(buy);
    // The old "1 good wallet" rule is now 1 conviction wallet: W never flipped, so it would count if it were good.
    const visibility = new TokenVisibility(feed, store, loadAppConfig({ PUBLIC_MIN_CONVICTION_WALLETS: "1" }, new Date()));
    expect(await visibility.isPublic("A")).toBe(false);

    // Once every result closed before the buy is stored, the buy is rated: none at that moment.
    clock = buy.timestamp.getTime() + MIN;
    await closer.tick();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(feed.smartWalletsOf("A").count).toBe(0);
    expect(await visibility.isPublic("A")).toBe(false);

    clock += 2 * HOUR;
    await closer.tick();
    expect(await store.tokenSmartSummary("A")).toEqual({ count: 0, elite: 0, holding: 0, conviction: 0 });
  });
});

/** Seeded PRNG (mulberry32), so a failing sequence can be replayed. */
const prng = (seed: number) => {
  let a = seed >>> 0;
  return (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

describe("property: the live tier and style of a buy always equal the canonical point-in-time recompute", () => {
  const WINDOW = 10 * MIN;
  const STEP = 10_000;
  const RULES: ReputationRules = {
    lookbackMs: 2 * HOUR,
    good: { minTokens: 2, minWinRatePct: 50, minNetPnlSol: 0 },
    elite: { minTokens: 4, minWinRatePct: 60, minNetPnlSol: 1 },
    botTokensPerHour: 1_000,
    // Lower style thresholds so the random trades produce every style (D7).
    style: { flipWindowMs: 120_000, convictionMaxFlipRatePct: 10, flipperMinFlipRatePct: 30 },
  };
  const WALLETS = ["w0", "w1", "w2", "w3", "w4", "w5"];
  const OTHERS = Array.from({ length: 50 }, (_, i) => `x${i}`);

  const allStyles: WalletStyle[] = [];
  afterAll(() => {
    // The seeds together exercise every style of a good-or-elite wallet.
    expect(new Set(allStyles)).toEqual(new Set(["conviction", "mixed", "flipper"]));
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])("seed %i", async (seed) => {
    const random = prng(seed);
    const store = newStore();
    const START = new Date("2026-11-01T00:00:00.000Z").getTime();
    let now = START;
    const { tracker, closer, live } = wire(store, RULES, WINDOW, () => new Date(now), 20_000);
    const tokens: NewToken[] = [];
    const firstBuys = new Map<string, Map<string, Date>>();

    for (let step = 0; step < 6 * 360; step += 1) {
      now += STEP;
      if (random() < 0.3) {
        const token = tok(`t${seed}-${tokens.length}`, now, random() < 0.2 ? WALLETS[Math.floor(random() * WALLETS.length)]! : "dev");
        tokens.push(token);
        await store.recordToken(token);
        tracker.track(token);
      }
      // Trades in open tokens, oldest first, some just past the window end (stored, never counted).
      for (const token of tokens.slice(-8)) {
        if (random() > 0.25) continue;
        const at = now;
        if (at < token.detectedAt.getTime() || at > token.detectedAt.getTime() + WINDOW + 20_000) continue;
        const wallet = random() < 0.6 ? WALLETS[Math.floor(random() * WALLETS.length)]! : OTHERS[Math.floor(random() * OTHERS.length)]!;
        const side = random() < 0.55 ? "buy" : "sell";
        const trade = tr(token.mint, wallet, side, at, 0.1 + random() * 2, 1000);
        await store.recordTrade(trade);
        tracker.tradeRecorded(trade);
        if (side === "buy" && wallet !== token.creator && at < token.detectedAt.getTime() + WINDOW) {
          const buys = firstBuys.get(token.mint) ?? new Map<string, Date>();
          if (!buys.has(wallet)) buys.set(wallet, trade.timestamp);
          firstBuys.set(token.mint, buys);
        }
      }
      if (step % 3 === 0) await closer.tick();
      tracker.prune(new Date(now));
    }
    now += WINDOW + HOUR;
    for (let i = 0; i < 100; i += 1) if (!(await closer.tick()).backlog) break;
    await new Promise((resolve) => setTimeout(resolve, 20));

    const results = await store.walletResults([...WALLETS, ...OTHERS], new Date(0));
    let checked = 0;
    let smart = 0;
    const styles = new Set<WalletStyle>();
    for (const [mint, buys] of firstBuys) {
      const canonical = new Map<string, string>();
      for (const [wallet, at] of buys) {
        const own = results.filter((result) => result.wallet === wallet && result.mint !== mint);
        const stats = statsAt(own, at, RULES.lookbackMs, RULES.style.flipWindowMs);
        const tier: WalletTier = tierOf(stats, RULES);
        const style: WalletStyle = styleOf(stats, RULES);
        if (tier !== "none") canonical.set(wallet, `${tier}/${style}`);
        if (tier !== "none") styles.add(style);
        checked += 1;
      }
      smart += canonical.size;
      expect([...(live.get(mint) ?? new Map())].sort(), `live ${mint}`).toEqual([...canonical].sort());
      const stored = await store.tokenSmartWallets(mint);
      expect(
        stored.map(({ wallet, tierAtEntry, styleAtEntry }) => [wallet, `${tierAtEntry}/${styleAtEntry}`]).sort(),
        `stored ${mint}`,
      ).toEqual([...canonical].sort());
      const conviction = [...canonical.values()].filter((value) => value.endsWith("/conviction")).length;
      expect((await store.tokenSmartSummary(mint)).conviction, `conviction ${mint}`).toBe(conviction);
    }
    expect(checked).toBeGreaterThan(50);
    expect(smart).toBeGreaterThan(0);
    allStyles.push(...styles);
  });
});
