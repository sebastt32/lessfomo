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
| `npm run create-superadmin` | Create the super admin on the compiled build (see [Authentication](#authentication)) |
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
| `AUTH_COOKIE_SECURE` | _(unset)_ | `true` always marks the session cookie `Secure`; by default it follows `X-Forwarded-Proto` |
| `AUTH_SESSION_DAYS` | `7` | Days a session lives after its last request (positive integer; invalid values use `7`) |
| `EVALUATION_DELAY_MS` | `60000` | Wait after a token is created before checking it |
| `MIN_INTERVAL_MS` | `4000` | Minimum time between checks (RugCheck allows ~15 requests per window) |
| `MAX_PENDING` | `50` | Tokens waiting to be checked; the oldest are skipped first |
| `PUBLIC_TRACKING_HOURS` | `24` | Hours after its creation that a public token keeps trade-by-trade data (see [Token cycle](#token-cycle)); any positive number, invalid values use `24` |
| `PUBLIC_MIN_CONVICTION_WALLETS` | `3` | Conviction wallets (at entry) a token needs to be shown by the public API (positive integer; invalid values use `3`). Replaces `PUBLIC_MIN_SMART_WALLETS`, which is no longer read |

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

## Smart wallets

Every wallet is rated by its own trading history, so the platform can show only tokens bought by
wallets with a good record.

**Result per wallet and token.** When a token's live tracking window (`TRACKING_WINDOW_MS`, counted
from its creation) ends, each wallet that bought it gets a result from the stored trades: SOL from
its sells, plus the tokens it still holds valued at the last observed price, minus the SOL it spent.
Only trades from its first buy on count; the token's creator never gets a result for its own token.

**Tiers** (from the results closed in the 7 days before a moment; a win is a positive result):

| Tier | Closed tokens | Win rate | Net PnL |
| --- | --- | --- | --- |
| `elite` | ≥ 10 | ≥ 65% | ≥ 5 SOL |
| `good` | ≥ 5 | ≥ 55% | > 0 SOL |
| `none` | otherwise | | |

`isBot` flags a wallet that first-buys 20 or more distinct tokens per active hour on average. It is
shown, not used to rate. The thresholds live in `walletReputation.rules` of `src/config/app-config.ts`.

**Style (hold time).** When a token closes, each wallet's result also keeps its first sell before
the close (sells after it never count). Its hold time is first sell minus first buy; a **flip** is a
token sold within 120 seconds of the first buy (never sold = not a flip). From the same prior
results as the tier, a good-or-elite wallet's style is:

| Style | Flip rate |
| --- | --- |
| `conviction` | ≤ 30% |
| `mixed` | between |
| `flipper` | ≥ 60% |
| `unrated` | tier `none` |

The window and thresholds live in `walletReputation.rules.style`. The style at a wallet's first buy
of a token is point in time like the tier, fixed for that token, and counted in
`smartWallets.conviction`; records also show the current `style`, `flipRate` and `medianHoldSeconds`.

**Point in time, no look-ahead.** A wallet's tier when it buys a token comes only from results that
closed strictly before that buy (and within the 7 days before it). Tokens close oldest first, so
every result that can rate a buy is stored before that buy is rated. The tier (and style) a wallet had at its
first buy of a token is fixed for that token. Filters, counts and the analysis all use these tiers;
`GET /api/wallets/:address` shows the current record (last 7 days before now).

**Live.** Good and elite wallets are kept in memory. On every stored trade of a tracked token, a
good or elite wallet's first buy (never the creator's) is counted in the token's
`smartWallets { count, elite, holding, conviction }`; `holding` drops when its observed balance
reaches zero. Live buys are rated with the same stored point-in-time stats as the close, so live and
stored tiers and styles agree.
Changes are stored per token and pushed as `smart-wallet` events on `/api/stream`. When the token
closes, its smart wallets are recomputed with the exact point-in-time tiers.

**Public visibility.** The public API only exposes tokens bought by at least
`PUBLIC_MIN_CONVICTION_WALLETS` (default 3) conviction wallets (style at entry). Flippers and mixed
wallets are shown in a token's details but never make it public. Lists (`/api/tokens`,
`/api/screenings`, `/api/movers`) leave the others out (`minConvictionWallets` defaults to that
minimum, lower values count as it; `minSmartWallets` is still accepted as an extra filter on
good-or-elite wallets); their detail, candles, snapshots
and smart wallets answer `404 TOKEN_NOT_FOUND` as if they did not exist; `/api/stream` skips their
events and announces a token (`token`, then its latest `screening`) the moment it reaches that
many conviction wallets; `/api/tokens/:mint/stream` sends nothing until then. `/api/wallets/:address` lists only
results in public tokens, although the record rates all of them. `/api/stats` and
`/api/analysis/smart-wallets` stay aggregates over every stored token, and every internal process
(reputation, snapshots, analysis) keeps using all the data; nothing is deleted.

**Close job and backfill.** Every tick (30 seconds, sooner while there is a backlog) the job closes
up to 25 tokens whose window ended 30 seconds ago, then refreshes the records of the affected
wallets (and, when idle, of records older than an hour, so results leaving the 7 days count). On
startup the same loop backfills every stored token in bounded batches, logging its progress; it is
idempotent and resumes after a restart. It only writes its own tables. Each close records a
version: tokens closed by an older version (before hold times and styles) are closed again, oldest
first, which backfills `first_sell_at`, styles at entry, conviction counts and conviction outcomes
from the stored trades. Until a token is closed again it has no conviction wallets, so it stays
hidden; live buys are rated once the backfill has caught up.

**Analysis.** For each closed token, the job also stores what copying its smart wallets would have
returned: entry at the price right after the k-th smart wallet's first buy (k = number of smart
wallets, capped at 5; with none, the last price at the first safety check), exit at 2× or at the
last price 10 minutes later, minus a 3% round-trip cost. `GET /api/analysis/smart-wallets` groups
those outcomes in buckets `0` … `5+` (statistics are `null` for an empty bucket; `reached2xPct` is
within the 10 minutes, `medianPeakX` over the rest of the live window). With `by=conviction` the
same statistics are grouped by conviction wallets, entered after the k-th conviction wallet's first
buy.

## Token cycle

For every public token the platform stores its cycle, the pattern "stable, explosion, crash", and
how long it could be bought before the explosion.

**Appeared.** A token appears at the moment it becomes public: the first buy of the conviction
wallet that made its count reach `PUBLIC_MIN_CONVICTION_WALLETS` (the time of that buy, not of its
rating a few seconds later). That moment is stored once and never changes, even if the token's
stored conviction wallets change later.

| Field | Rule |
| --- | --- |
| Launch price | Price of the first trade seen |
| Base price | Price of the last trade at or before the appearance |
| Appeared late | Before appearing, the price had already reached 2× the launch price. The invest window is then negative: minus the seconds between that first 2× and the appearance |
| Explosion | First trade after appearing priced at least 2× the base |
| Run-up start | Last trade before the explosion priced at most 1.2× the base (the appearance if there is none) |
| Invest window | Run-up start minus appearance, once exploded |
| Peak | Highest price from the explosion until the crash |
| Crash | First trade after the peak priced at most 50% of it. The cycle is then complete: peak and crash stay; the last price and the deepest fall from the peak keep updating |
| Phase | `stable` until the explosion, `exploding` until the crash, then `crashed` |

The thresholds (2×, 1.2×, 50%, 2× for late) live in `tokenCycle.rules` of `src/config/app-config.ts`.

**No look-ahead.** The cycle is a state machine folded over the token's prices in time order: each
field comes only from the prices up to that moment, a recorded explosion, run-up start or crash
never moves, and each stored trade is folded exactly once (a cursor is stored with the cycle), so a
restart continues where it stopped.

**Trade-by-trade data for 24 hours.** From the moment it appears, a public token keeps storing its
trades (and publishing them on its stream) until `PUBLIC_TRACKING_HOURS` after its creation, from
the same Solana log subscription. Only public tokens are extended, at most 2,000 at once (when
full, the most recently appeared are kept). Nothing else changes: momentum still follows a token
for `TRACKING_WINDOW_MS`, wallet results still close at that window using only the trades before it,
and snapshots keep their schedule. After a restart the public tokens still inside their 24 hours are
followed again. Once trades stop, the cycle continues from the prices of the token's
[snapshots](#snapshots), so late peaks and crashes are still recorded; a snapshot price only counts
when the token had no stored trade in the 2 minutes before it.

**Backfill.** On startup (and every 30 seconds afterwards, for tokens that became public through
the reputation backfill) stored public tokens without a cycle get theirs from their stored trades
and snapshot prices, newest first, 20 tokens per tick, logging its progress as `[cycles] ...`. It
resumes after a restart, never recomputes a finished cycle and only writes `token_cycles`.

**API.** `cycle` on movers, token lists, screenings and the token detail; `phase` and `appearedLate`
filters and `appearedAt` / `investWindow` sorts on `GET /api/tokens`; a `cycle` event on both streams
(the token appears, changes phase, or sets a new peak, at most one every 10 seconds per token);
and `GET /api/analysis/cycles` with the share that appeared in time, exploded and crashed, and how
much window they gave. All of it behind the sign-in and the public visibility rule.

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
| `trades` | Every trade of a tracked token; for public tokens, until `PUBLIC_TRACKING_HOURS` after their creation |
| `momentum_snapshots` | Score, components and metrics per token per minute (active tokens only) |
| `token_state` | Latest state of each token (status, liquidity, prices, max score, holders, last trade) and its snapshot schedule |
| `token_snapshots` | Every snapshot of [Snapshots](#snapshots) |
| `token_closures` | Tokens whose wallet results are closed |
| `wallet_token_results` | Result of every wallet in every closed token |
| `wallet_reputation` | Latest record of every wallet with results |
| `token_smart_wallets`, `smart_wallet_tokens` | Smart wallets of each token (tier and style at entry) and their counts (`conviction` included) |
| `smart_wallet_outcomes` | Outcome of each closed token for the smart-wallet analysis |
| `conviction_outcomes` | The same outcome counting conviction wallets only (`by=conviction`) |
| `token_cycles` | Cycle of each public token: when it appeared, base price, explosion, peak, crash, and the cursor it continues from |
| `users` | Who may sign in: username (unique ignoring case), password hash and role |
| `sessions` | Open sessions by the SHA-256 of their token, with their expiry |

The smart-wallet tables are created on startup in older databases too, and filled by the backfill.
Columns added later (`token_closures.version`, `wallet_token_results.first_sell_at`,
`token_smart_wallets.style_at_entry`, `smart_wallet_tokens.conviction`, `wallet_reputation.style`,
`flip_rate`, `median_hold_seconds`) are added on startup to these derived tables only; raw tables
are never altered.
`token_cycles` is created on startup in older databases too and filled by its backfill; no existing table changes.
`users` and `sessions` are created on startup in older databases too, and both get a
`credential_version` column added on startup (existing sessions stay valid); no other table changes.
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
[lessfomo-frontend](https://github.com/sebastt32/lessfomo-frontend). Everything except
`GET /api/health` requires signing in (see [Authentication](#authentication)).

| Endpoint | Description |
| --- | --- |
| `GET /api/health` | Status and data source health |
| `GET /api/movers` | Latest momentum ranking (`minConvictionWallets`, `minSmartWallets` filters) |
| `GET /api/screenings` | Recent safety check results (`minConvictionWallets`, `minSmartWallets` filters) |
| `GET /api/tokens` | Every token ever detected, paginated, with date, status, lifecycle, score, text, `minConvictionWallets`, `minSmartWallets`, `phase` and `appearedLate` filters, `sort=convictionWallets:desc`, `smartWallets:desc`, `appearedAt` or `investWindow` |
| `GET /api/tokens/:mint/smart-wallets` | Smart wallets of a token, with the record that makes each one good |
| `GET /api/wallets/:address` | A wallet's current record and its results of the last 7 days |
| `GET /api/analysis/smart-wallets` | Success of tokens by number of smart wallets (`from`, `to`, `by=conviction`) |
| `GET /api/analysis/cycles` | Share of public tokens that appeared in time, exploded and crashed, and their invest windows (`from`, `to`) |
| `GET /api/tokens/:mint` | Full history of one token (public tokens only, like every token endpoint) |
| `GET /api/tokens/:mint/snapshots` | Snapshots of one token, oldest first |
| `GET /api/tokens/:mint/candles` | OHLCV candles (`interval=1s\|1m\|5m\|15m\|1h`, `limit` up to 2000), dev trades and SOL/USD price |
| `GET /api/tokens/:mint/stream` | Live `trade`, `cycle` and `sol-price` events of one token |
| `GET /api/stats` | Totals: tokens (active, dead, migrated), statuses, trades, snapshots |
| `GET /api/stream` | Live `token`, `screening`, `momentum`, `status`, `smart-wallet` and `cycle` events |
| `POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/logout`, `POST /api/auth/password` | Sign in, current user, sign out, change password |

Candles are built on request from the stored `trades` table, so they cover every trade of a
tracked token. The SOL/USD price (for market caps in USD) is polled every minute from free,
keyless public APIs: Jupiter, falling back to CoinGecko and then Binance. It is `null` while
none of them answers.

The full contract is in [docs/API.md](docs/API.md).

## Authentication

The whole platform is behind one sign-in: every endpoint and both streams answer
`401 UNAUTHENTICATED` without a session, except `GET /api/health`, `POST /api/auth/login` and
`POST /api/auth/logout`. There is no public sign-up. The contract is in
[docs/API.md](docs/API.md#authentication).

### Create or reset the super admin

Run the command where the app runs, with the same environment (`DATABASE_URL` or
`LESSFOMO_DB_PATH`), so it writes to the same history store. It only opens that store: it does not
start the screener, the API or any network source, and it can run next to the running app.

```bash
npm run build
node dist/create-superadmin.js            # creates "superadmin"
node dist/create-superadmin.js alice      # another username
node dist/create-superadmin.js --reset    # new password for "superadmin", signed out everywhere

docker exec -it <container> node dist/create-superadmin.js   # in the Docker image
```

It prints the username and a random 32-character password **once**; only the password's hash is
stored, so save it then and change it after signing in. If the user already exists it exits with
code 1 and changes nothing unless `--reset` is given. No credentials live in the environment or in git.

### How it works

| What | How |
| --- | --- |
| Passwords | `scrypt` (N=2^15, r=8, p=3) with a random salt per user, compared in constant time. An unknown username costs the same work as a wrong password. New passwords need 12+ characters |
| Sessions | A random 32-byte token in the `lessfomo_session` cookie (`HttpOnly`, `SameSite=Lax`, `Path=/`); the database keeps only its SHA-256. Valid for `AUTH_SESSION_DAYS` after the last request (refreshed at most once a minute). Expired sessions are deleted hourly |
| Sign-in limit | 5 failed attempts per username and client IP in 15 minutes, and 30 per client IP across usernames, then `429` until the window ends. Kept in memory, so a restart forgets it. Wrong current passwords when changing the password count too. At most 10,000 usernames and client IPs are counted at once and none is forgotten inside its window: when full, new ones get `429` until the oldest window ends |
| Busy server | At most 4 sign-in passwords are verified at once and 32 wait; beyond that the answer is `503 SERVER_BUSY` with `Retry-After: 2`, without hashing and without counting a failed attempt. Password changes (signed-in users only) have their own bound, 2 at once and 8 waiting, so a flood of sign-ins cannot block them |
| Cross-site requests | The auth `POST`s need `Content-Type: application/json` and, when the browser sends `Origin`, an allowed CORS origin or the API's own host, otherwise `403 FORBIDDEN_ORIGIN` |
| Ending a session | Signing out, changing the password (every other session of the user) and `--reset` (all of them) delete sessions; their open streams are closed, at the latest on the next heartbeat. A password change or reset replaces the hash and ends those sessions in one transaction, and every session carries the `credential_version` of the password it was opened with, so a sign-in that was checking the old password meanwhile gets `401` and no session |
| Failures | If a session cannot be checked the answer is `401`, never access |

### Security notes

- **Use HTTPS.** Over plain HTTP the password and the session cookie travel readable. The cookie is
  marked `Secure` when the proxy sends `X-Forwarded-Proto: https`; set `AUTH_COOKIE_SECURE=true` to
  force it once the site is only served over HTTPS.
- **Keep the API behind the dashboard's reverse proxy** (do not publish its port). The client IP of
  the sign-in limit is the first hop of `X-Forwarded-For`, which is only trustworthy when a proxy
  sets it; reached directly, a client could send any value and dodge the per-IP limit (it would
  still need the password). No other forwarded header is used for a security decision.
- **Same-origin check.** A dashboard served from another origin than the one in `Host` must be listed
  in `CORS_ORIGIN`. A reverse proxy in front of the API should forward the public host
  (`proxy_set_header Host $host` in nginx); otherwise list the public origin in `CORS_ORIGIN`, or
  browser sign-ins are answered `403 FORBIDDEN_ORIGIN`.
- Passwords, tokens, cookies and hashes are never logged.

## Pipeline

```
PumpPortal (new tokens) ──┬─→ safety checks (Solana RPC + RugCheck) ─┐
                          │                                         ├─→ console + history (PostgreSQL or SQLite)
Solana RPC logs (trades) ─┼─→ momentum tracker (every minute) ──────┤
                          ├─→ token cycles (public tokens, 24 h) ───┤
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
| `HistoryModule` | `HISTORY_STORE`, `HISTORY_READER`, `HISTORY_RECORDER`, `TOKEN_CATALOG_READER`, `SNAPSHOT_STORE`, `WALLET_REPUTATION_STORE`, `TOKEN_CYCLE_STORE` (PostgreSQL or SQLite) |
| `WalletReputationModule` | `SMART_WALLET_TRACKER`, `REPUTATION_CLOSER`, `WALLET_REPUTATION_QUERIES` |
| `TokenCycleModule` | `TOKEN_CYCLE_TRACKER` (cycles of public tokens, live and backfill), `EXTENDED_TRADE_STORAGE`, `TOKEN_CYCLE_QUERIES` |
| `SnapshotsModule` | `SNAPSHOT_SCHEDULER`, `MARKET_DATA_SOURCE` (DexScreener) |
| `LiveFeedModule` | `LIVE_FEED` |
| `MarketPriceModule` | `SOL_PRICE_FEED`, `SOL_USD_PRICE` |
| `ScreeningModule` | `ScreeningPipeline`, which wires the sources to the screener, history, snapshots and feed |
| `AuthModule` | `AUTH_SERVICE`, `USER_STORE`, `SESSION_STORE`, `AUTH_CLOCK` and the `/api/auth/*` controller (sign-in for the whole platform) |
| `ApiModule` | Controllers, CORS/session guard/method middleware, error filter and SSE streams of `docs/API.md` |

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

Create the super admin inside the running container with
`docker exec -it <container> node dist/create-superadmin.js` (see [Authentication](#authentication)).

Without `DATABASE_URL`, history goes to SQLite at `/data/lessfomo.db`; mount a volume on
`/data` to keep it. Set `CORS_ORIGIN` to the dashboard origin when it calls the API directly.

> Passing the filters does not make a token profitable. It only removes obvious scams.
