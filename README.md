# lessfomo

Real-time memecoin screener for Solana. It detects new pump.fun tokens, discards the
ones that fail basic safety checks, scores their on-chain buying momentum, snapshots the
state of every token over time, and stores everything (in PostgreSQL, or a local SQLite
file) so the momentum hypothesis can be validated later.

It only uses free, keyless data sources.

## Requirements

- Node.js 24+

## Getting started

```bash
npm install
cp .env.example .env
npm run dev
```

## Scripts

| Script | Description |
| --- | --- |
| `npm run dev` | Run in watch mode with `tsx` |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled build |
| `npm run typecheck` | Type-check without emitting |
| `npm test` | Run tests with Vitest |

## Configuration

All variables are optional.

| Variable | Default | Description |
| --- | --- | --- |
| `SOLANA_RPC_URL` | `https://api.mainnet-beta.solana.com` | Solana RPC used to read mint authorities |
| `SOLANA_WS_URL` | `wss://api.mainnet-beta.solana.com` | Solana RPC WebSocket used to stream pump.fun trades |
| `DATABASE_URL` | _(unset)_ | PostgreSQL connection string (`postgres://user:password@host:5432/db`). When unset, history is stored in SQLite |
| `LESSFOMO_DB_PATH` | `data/lessfomo.db` | SQLite file where history is stored when `DATABASE_URL` is unset |
| `TRACKING_WINDOW_MS` | `3600000` | How long each new token is followed for momentum |
| `API_HOST` | `127.0.0.1` | Interface the HTTP API binds to (local only by default) |
| `API_PORT` | `3001` | HTTP API port |
| `CORS_ORIGIN` | `http://localhost:5173` | Comma-separated browser origins allowed to call the API |
| `EVALUATION_DELAY_MS` | `60000` | Wait after a token is created before checking it |
| `MIN_INTERVAL_MS` | `4000` | Minimum time between checks (RugCheck allows ~15 requests per window) |
| `MAX_PENDING` | `50` | Tokens waiting to be checked; the oldest are skipped first |

## Safety checks

Only free, keyless data sources are used:

- **Solana RPC** (`getAccountInfo`): mint authority, freeze authority and dangerous Token-2022 extensions.
- **RugCheck** (`/v1/tokens/{mint}/report`): top holders, creator balance and insider networks. The bonding curve, pools and lockers are excluded.

| Rule | Fails when |
| --- | --- |
| `MINT_AUTHORITY_ACTIVE` | Someone can still mint new tokens |
| `FREEZE_AUTHORITY_ACTIVE` | Someone can still freeze holder accounts |
| `DANGEROUS_EXTENSION` | `permanentDelegate`, `transferHook`, `nonTransferable`, frozen `defaultAccountState`, `pausableConfig`, `transferFeeConfig` or `mintCloseAuthority` is active |
| `TOP_HOLDERS_CONCENTRATED` | Top 10 wallets hold more than 30% |
| `CREATOR_HOLDS_TOO_MUCH` | Creator holds more than 10% |
| `INSIDER_NETWORK_DETECTED` | Connected insider wallets are detected |
| `NOT_ENOUGH_HOLDERS` | Fewer than 20 holders |

If a data source fails or has no data, the token is reported as `UNVERIFIED`, never as passed.

## Momentum score

Trades come from the public Solana RPC (`logsSubscribe` on the pump.fun program); the
`TradeEvent` emitted by pump.fun is decoded directly from the logs, including the curve's
real reserves (see [Liquidity](#liquidity)). Every new token is
followed for `TRACKING_WINDOW_MS`, and its momentum is computed every minute from the
last five minutes of trades. The creator's own trades are excluded.

| Component | Meaning |
| --- | --- |
| Activity | Unique buyers in the last 5 minutes, full at 50 |
| Acceleration | Unique buyers in the last minute versus the average of the 4 minutes before |
| Buy pressure | How much bought SOL volume exceeds sold volume |

```
score = 100 × activity × (0.40 + 0.35 × acceleration + 0.25 × buy pressure)
```

Activity multiplies everything, so a handful of wallets can never reach a high score.

> Score v1 is a hypothesis, not a proven model. Validate it with the stored data before trusting it.

## Liquidity

Liquidity comes from the same `TradeEvent`: right after the stable prefix (mint, amounts,
side, user, timestamp, virtual reserves) it carries `real_sol_reserves` and
`real_token_reserves` (u64 each, as in the pump.fun IDL), checked against live events and
the bonding-curve accounts on mainnet.

| Field | Meaning |
| --- | --- |
| `sol` | `real_sol_reserves / 1e9`: SOL actually in the curve; after migration, the SOL side of the pool (DexScreener) |
| `bondingCurvePct` | Share of the curve's 793,100,000 sellable tokens already bought, `100` once complete |
| `migrated` | The curve completed (`real_token_reserves = 0`, the trade that emits `CompleteEvent`) or DexScreener lists a non-pump.fun pool |

The initial reserves (30 virtual SOL, 1,073,000,000 virtual and 793,100,000 real tokens) are
read from the program's `Global` account. A curve's virtual minus real reserves never change,
so curves created with other parameters (custom depth, other quote tokens) are recognized and
report `bondingCurvePct: null` instead of a wrong value.

## Snapshots

The state of every detected token is stored on a logarithmic schedule counted from its
creation, dense while most tokens live or die and sparse for survivors:

```
0m 1m 5m 10m 15m 30m · 1h 2h 4h 6h 12h 24h · d2 … d7 (daily) · w2 w3 … (weekly, while active)
```

plus event snapshots: `event:migrated` (curve completed), `event:new-peak` (new highest
price, at most one per milestone window) and `event:holders-100/500/1000`. A token with no
trades for 24 hours is `dead` and its schedule stops.

| Source | Used for |
| --- | --- |
| Stored trades | Snapshots up to `TRACKING_WINDOW_MS`: price, volume, buys, sells and unique buyers since the previous snapshot |
| Trade stream | Latest price, peak and liquidity of every watched token, also after the live window |
| [DexScreener](https://docs.dexscreener.com/api/reference) `/tokens/v1/solana/{mints}` | Later snapshots: price, market cap, pool liquidity, and volume/buys/sells when one of its rolling windows (5m, 1h, 6h, 24h) matches the time since the previous snapshot. Up to 30 mints per request, at most one request per second |
| RugCheck | Holders, top 10 share and creator share, only for tokens still active from the 1h milestone on, one read every 15 seconds at most |

The schedule is stored with each token, so a restart resumes it: milestones missed while the
process was down are collapsed into the latest one, taken late with its real time. Each tick
(every 5 seconds) handles at most 100 due tokens and 60 DexScreener quotes.

## History

Everything is stored in PostgreSQL when `DATABASE_URL` is set, otherwise in a local
SQLite file (Node's built-in `node:sqlite`). Both stores use the same tables and columns,
and PostgreSQL tables are created automatically on startup. Timestamps are Unix epoch
milliseconds (`BIGINT` in PostgreSQL). Storage errors are logged and never stop the
live streams.

| Table | Contents |
| --- | --- |
| `tokens` | Every detected token |
| `screenings` | Each safety check result, failure codes and holder metrics |
| `trades` | Every trade of a tracked token |
| `momentum_snapshots` | Score, components and metrics per token per minute (active tokens only) |
| `token_state` | Latest state of each token (status, liquidity, prices, max score, holders, last trade) and its snapshot schedule |
| `token_snapshots` | Every snapshot of [Snapshots](#snapshots) |

`token_state` and `token_snapshots` are created on startup in older databases too; the state
of tokens stored before them is rebuilt from their screenings, momentum and trades.

Example: did tokens that scored 60+ go up over the next 15 minutes?

```sql
SELECT s.mint, s.at, s.score, s.last_price_sol,
       (SELECT MAX(t.price_sol) FROM trades t
         WHERE t.mint = s.mint AND t.timestamp BETWEEN s.at AND s.at + 900000) AS max_price_next_15m
FROM momentum_snapshots s
WHERE s.score >= 60;
```

## HTTP API

While running, the screener exposes a read-only JSON + Server-Sent Events API on
`http://127.0.0.1:3001` for dashboards such as
[lessfomo-frontend](https://github.com/sebastt32/lessfomo-frontend).

| Endpoint | Description |
| --- | --- |
| `GET /api/health` | Status and data source health |
| `GET /api/movers` | Latest momentum ranking |
| `GET /api/screenings` | Recent safety check results |
| `GET /api/tokens` | Every token ever detected, paginated, with date, status, lifecycle, score and text filters |
| `GET /api/tokens/:mint` | Full history of one token |
| `GET /api/tokens/:mint/snapshots` | Snapshots of one token, oldest first |
| `GET /api/tokens/:mint/candles` | OHLCV candles (`interval=1s\|1m\|5m`, `limit`), dev trades and SOL/USD price |
| `GET /api/tokens/:mint/stream` | Live `trade` and `sol-price` events of one token |
| `GET /api/stats` | Totals: tokens (active, dead, migrated), statuses, trades, snapshots |
| `GET /api/stream` | Live `token`, `screening`, `momentum` and `status` events |

Candles are built on request from the stored `trades` table, so they cover every trade of a
tracked token. The SOL/USD price (for market caps in USD) is polled every minute from free,
keyless public APIs: Jupiter, falling back to CoinGecko and then Binance. It is `null` while
none of them answers.

The full contract is in [docs/API.md](docs/API.md).

## Pipeline

```
PumpPortal (new tokens) ──┬─→ safety checks (Solana RPC + RugCheck) ─┐
                          │                                         ├─→ console + history (PostgreSQL or SQLite)
Solana RPC logs (trades) ─┼─→ momentum tracker (every minute) ──────┤
                          └─→ snapshots (+ DexScreener, RugCheck) ──┤
                                                                    └─→ live feed → HTTP + SSE API
```

## Architecture

[NestJS](https://nestjs.com) (Express platform) organizes the edge; the domain under each
`src/<capability>/domain` stays plain TypeScript without decorators. Each capability has one
Nest module whose ports are injection tokens (always injected with an explicit `@Inject(TOKEN)`,
because `tsx` and Vitest do not emit decorator metadata):

| Module | Provides |
| --- | --- |
| `TokenDiscoveryModule` | `NEW_TOKEN_SOURCE` (PumpPortal) |
| `SafetyChecksModule` | `MINT_AUTHORITY_READER`, `HOLDER_DISTRIBUTION_READER`, `SAFETY_THRESHOLDS` |
| `MomentumModule` | `MOMENTUM_TRACKER`, `TRADE_SOURCE` (Solana logs) |
| `HistoryModule` | `HISTORY_STORE`, `HISTORY_READER`, `HISTORY_RECORDER`, `TOKEN_CATALOG_READER`, `SNAPSHOT_STORE` (PostgreSQL or SQLite) |
| `SnapshotsModule` | `SNAPSHOT_SCHEDULER`, `MARKET_DATA_SOURCE` (DexScreener) |
| `LiveFeedModule` | `LIVE_FEED` |
| `MarketPriceModule` | `SOL_PRICE_FEED`, `SOL_USD_PRICE` |
| `ScreeningModule` | `ScreeningPipeline`, which wires the sources to the screener, history, snapshots and feed |
| `ApiModule` | Controllers, CORS/method middleware, error filter and SSE streams of `docs/API.md` |

`src/main.ts` reads the environment once (`src/config/app-config.ts`), starts the API and then
the pipeline. If the API cannot start, the screener keeps running. On `SIGINT`/`SIGTERM` it stops
the pipeline, then the API and its streams, then closes the history, and exits with code 0.

## Docker

The `Dockerfile` builds a production image that runs `node dist/main.js` as the non-root
`node` user and listens on port `3001` on all interfaces (`API_HOST=0.0.0.0`).

```bash
docker build -t lessfomo .
docker run -p 3001:3001 -e DATABASE_URL=postgres://user:password@host:5432/lessfomo lessfomo
```

Without `DATABASE_URL`, history goes to SQLite at `/data/lessfomo.db`; mount a volume on
`/data` to keep it. Set `CORS_ORIGIN` to the dashboard origin when it calls the API directly.

> Passing the filters does not make a token profitable. It only removes obvious scams.
