# lessfomo HTTP API

Read-only JSON API exposed by the screener while it runs. It binds to `127.0.0.1:3001`
by default, so it is only reachable from the same machine.

| Variable | Default | Description |
| --- | --- | --- |
| `API_HOST` | `127.0.0.1` | Interface to bind. Use `0.0.0.0` only if you understand the exposure |
| `API_PORT` | `3001` | Port |
| `CORS_ORIGIN` | `http://localhost:5173` | Comma-separated origins allowed to call the API from a browser |

Conventions:

- All timestamps are ISO 8601 strings in UTC.
- Percentages go from 0 to 100; components go from 0 to 1.
- Errors use `{ "error": { "code": string, "message": string } }` with a matching HTTP status.
- `limit` query parameters are clamped to `1..100`; invalid values fall back to the default.
- Generic errors: `404 NOT_FOUND` (unknown route), `405 METHOD_NOT_ALLOWED` (anything but `GET`/`OPTIONS`),
  `400 BAD_REQUEST` (unparseable request target), `500 INTERNAL_ERROR` (never includes internal details).

## Authentication

Every endpoint and stream except `GET /api/health` and `POST /api/auth/login` requires a signed-in
session. Without one they answer `401 { "error": { "code": "UNAUTHENTICATED", ... } }` and reveal
nothing (the check runs before validation and before the public visibility rule).

The session is a cookie named `lessfomo_session` (`HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` over
HTTPS), valid for 7 days from the last request. Browsers on another origin (local development) must
send credentials (`fetch` with `credentials: "include"`, `EventSource` with `withCredentials`); CORS
answers allowed origins with `Access-Control-Allow-Credentials: true`. Allowed origins also get
`Access-Control-Expose-Headers: Retry-After`, so they can read it on `429 TOO_MANY_ATTEMPTS`.

State-changing requests must send `Content-Type: application/json`; when an `Origin` header is
present it must be the API's own origin or an allowed CORS origin, otherwise `403 FORBIDDEN_ORIGIN`.

```ts
interface SessionUser { username: string; role: "superadmin"; }
```

| Endpoint | Body | Success | Errors |
| --- | --- | --- | --- |
| `POST /api/auth/login` | `{ "username": string, "password": string }` | `200 { "user": SessionUser }` + session cookie | `400 INVALID_BODY`, `401 INVALID_CREDENTIALS` (same answer for unknown user and wrong password), `429 TOO_MANY_ATTEMPTS` with `Retry-After` seconds (see "Sign-in limits"), `503 SERVER_BUSY` with `Retry-After: 2` |
| `GET /api/auth/me` | — | `200 { "user": SessionUser }` | `401 UNAUTHENTICATED` |
| `POST /api/auth/logout` | — | `204`, cookie cleared, session deleted | — (also `204` without a session) |
| `POST /api/auth/password` | `{ "currentPassword": string, "newPassword": string }` | `204`; every other session of the user is deleted | `401 UNAUTHENTICATED`, `401 INVALID_CREDENTIALS` (wrong current password), `400 WEAK_PASSWORD` (new password shorter than 12 characters or equal to the current one), `429 TOO_MANY_ATTEMPTS`, `503 SERVER_BUSY` |

Once `POST /api/auth/password` answers `204` (or `create-superadmin --reset` finishes), no session
opened with the previous password is valid, including one from a sign-in that was in progress: such
a sign-in answers `401 INVALID_CREDENTIALS`.

Sign-in limits (failed attempts; wrong current passwords on `POST /api/auth/password` count too):

| Limit | Answer |
| --- | --- |
| 5 failures per username and client IP in 15 minutes | `429 TOO_MANY_ATTEMPTS`, `Retry-After`: seconds left in the window |
| 30 failures per client IP in 15 minutes, across usernames | `429 TOO_MANY_ATTEMPTS`, `Retry-After`: seconds left in the window |
| More than 10,000 usernames or client IPs being counted at once | `429 TOO_MANY_ATTEMPTS` for those not yet counted, until the oldest window ends |
| More than 4 sign-in passwords being checked with 32 waiting (password changes: 2 with 8 waiting, counted apart) | `503 { "error": { "code": "SERVER_BUSY", ... } }` with `Retry-After: 2`; nothing was checked and it is not counted as a failure |

A `429` is answered even for the right password.

Other methods than `GET`/`OPTIONS` stay `405 METHOD_NOT_ALLOWED` outside `/api/auth/*`. There is no
public sign-up: the super admin is created on the server with `node dist/create-superadmin.js`.

| Variable | Default | Description |
| --- | --- | --- |
| `AUTH_COOKIE_SECURE` | unset | `true` forces the `Secure` cookie flag; by default it follows `X-Forwarded-Proto` |
| `AUTH_SESSION_DAYS` | `7` | Session lifetime in days (sliding) |

## Types

```ts
type SafetyStatus = "pending" | "passed" | "failed" | "unverified";

interface TokenView {
  mint: string;
  symbol: string;
  name: string;
  creator: string;
  metadataUri: string;
  initialBuySol: number;
  marketCapSol: number;
  detectedAt: string;
}

interface ScreeningView {
  mint: string;
  symbol: string;
  name: string;
  status: "passed" | "failed" | "unverified";
  reason: string | null;          // only for "unverified"
  failureCodes: string[];         // empty unless "failed"
  top10Pct: number | null;
  creatorPct: number | null;
  totalHolders: number | null;
  evaluatedAt: string;
  detectedAt: string | null;      // the token's creation time; null if unknown
}

interface MomentumComponents {
  activity: number;
  acceleration: number;
  buyPressure: number;
}

interface MomentumMetrics {
  uniqueBuyers1m: number;
  uniqueBuyers5m: number;
  avgUniqueBuyersPrevMinutes: number;
  buyVolumeSol5m: number;
  sellVolumeSol5m: number;
  tradeCount5m: number;
  medianBuySol5m: number;
  priceChange5mPct: number;
  lastPriceSol: number | null;
}

interface Mover {
  mint: string;
  symbol: string;
  name: string;
  status: SafetyStatus;
  detectedAt: string;
  score: number;                  // 0-100
  components: MomentumComponents;
  metrics: MomentumMetrics;
}

interface MomentumPoint {
  at: string;
  score: number;
  components: MomentumComponents;
  metrics: MomentumMetrics;
}

type SourceStatus = "connecting" | "connected" | "disconnected";

type CandleInterval = "1s" | "1m" | "5m" | "15m" | "1h";

interface Candle {
  time: number;                   // bucket start, Unix seconds (UTC)
  open: number;                   // prices in SOL per token
  high: number;
  low: number;
  close: number;
  volumeSol: number;
  buyVolumeSol: number;
  sellVolumeSol: number;
  trades: number;
}

interface DevTrade {
  time: number;                   // Unix seconds
  side: "buy" | "sell";
  solAmount: number;
}

interface TradeView {
  signature: string;
  trader: string;
  side: "buy" | "sell";
  solAmount: number;
  tokenAmount: number;
  priceSol: number;
  isDev: boolean;                 // trader is the token creator
  time: number;                   // Unix seconds
}
```

Market cap is derived on the client: `priceSol × totalSupply`, and in USD `× solUsd`.

```ts
/** Liquidity of the token's market. On the pump.fun bonding curve it is the real SOL in the curve. */
interface Liquidity {
  sol: number | null;             // null until a trade or pool reading is known
  bondingCurvePct: number | null; // 0-100 progress of the pump.fun curve; 100 once migrated; null if unknown
  migrated: boolean;              // true once the token moved to PumpSwap
}

type Lifecycle = "active" | "dead";   // dead = no trades for 24 hours

type SnapshotMilestone =
  | "0m" | "1m" | "5m" | "10m" | "15m" | "30m"
  | "1h" | "2h" | "4h" | "6h" | "12h" | "24h"
  | "d2" | "d3" | "d4" | "d5" | "d6" | "d7"      // daily for 7 days
  | "w2" | "w3" | "w4" | "w5" | "w6" | "w7" | "w8" // then weekly (continues while active)
  | "event:migrated" | "event:new-peak"
  | "event:holders-100" | "event:holders-500" | "event:holders-1000";

interface TokenSnapshot {
  milestone: SnapshotMilestone | string;  // weekly milestones continue past w8 (w9, w10, ...)
  at: string;                     // ISO time the snapshot was taken
  priceSol: number | null;
  marketCapSol: number | null;
  volumeSol: number | null;       // volume since the previous snapshot
  buys: number | null;            // since the previous snapshot
  sells: number | null;
  uniqueBuyers: number | null;    // since the previous snapshot
  holders: number | null;
  top10Pct: number | null;
  devHoldsPct: number | null;
  liquidity: Liquidity;
  source: "trades" | "dexscreener" | "rugcheck" | "mixed";
}

interface TokenListItem {
  token: TokenView;               // detectedAt is the token's creation date and time
  status: SafetyStatus;
  lifecycle: Lifecycle;
  liquidity: Liquidity;           // latest known
  lastPriceSol: number | null;
  lastMarketCapSol: number | null;
  peakMarketCapSol: number | null;
  maxScore: number | null;        // highest momentum score ever recorded
  holders: number | null;         // latest known
  lastTradeAt: string | null;
  snapshotCount: number;
}
```

`Mover` gains `liquidity: Liquidity`. `TokenView.detectedAt` is shown as the creation date and time.

### Smart wallets

A wallet's reputation is **point-in-time**: when it buys a token, its tier comes only from tokens
whose results closed before that buy. A token's result per wallet closes when the token's live
tracking window ends (realized SOL from sells, plus remaining tokens valued at the last observed price).

```ts
type WalletTier = "elite" | "good" | "none";

/** How a wallet usually trades (point-in-time, from the same prior results as its tier).
 *  A "flip" is a token it sold within 120 s of its first buy (sells after the token's close ignored). */
type WalletStyle = "conviction" | "flipper" | "mixed" | "unrated";   // conviction: flip rate ≤ 30%; flipper: ≥ 60%; unrated: tier none

interface WalletRecord {
  address: string;
  tier: WalletTier;               // current tier (from closed results in the last 7 days)
  isBot: boolean;                 // trades ≥ 20 distinct tokens per hour on average
  tokens: number;                 // closed tokens in the last 7 days
  wins: number;                   // closed tokens with positive result
  winRate: number;                // 0-100
  netPnlSol: number;              // sum of closed results, last 7 days
  avgPnlSol: number;
  medianEntrySeconds: number | null;  // seconds from token creation to its first buy
  style: WalletStyle;             // current style (last 7 days)
  flipRate: number | null;        // 0-100, share of closed tokens sold within 120 s; null when no closed tokens
  medianHoldSeconds: number | null;   // first buy to first sell; tokens never sold before close are excluded
  lastActiveAt: string | null;
  updatedAt: string;
}

interface WalletTokenResult {
  mint: string; symbol: string; name: string;
  firstBuyAt: string; entrySeconds: number;   // seconds after the token's creation
  boughtSol: number; soldSol: number; pnlSol: number;
  closedAt: string;
}

interface SmartWalletInToken {
  address: string;
  tierAtEntry: WalletTier;        // point-in-time tier when it first bought this token
  styleAtEntry: WalletStyle;      // point-in-time style when it first bought this token
  record: WalletRecord;           // current record, to explain why it is good
  firstBuyAt: string; entrySeconds: number;
  boughtSol: number; soldSol: number;
  stillHolding: boolean;          // positive balance per observed trades
}
```

`Mover`, `TokenListItem` and `ScreeningView` gain
`smartWallets: { count: number; elite: number; holding: number; conviction: number }`
(good-or-elite wallets, by tier at entry, that bought the token; `holding` = still holding;
`conviction` = of those, how many had the conviction style at entry). The same object is sent in
the `smart-wallet` event.

## Endpoints

### `GET /api/health`

```json
{ "status": "ok", "startedAt": "2026-11-13T20:00:00.000Z",
  "sources": { "pumpportal": "connected", "solanaLogs": "connected" } }
```

### `GET /api/movers?limit=20`

Latest momentum ranking, highest score first. `at` is `null` until the first minute has passed.

```json
{ "at": "2026-11-13T20:05:00.000Z", "movers": [Mover] }
```

### `GET /api/screenings?limit=50`

Most recent safety check results from history, newest first.

```json
{ "screenings": [ScreeningView] }
```

### `GET /api/tokens/:mint`

Full history of one token. Momentum points are oldest first. `404` with code
`TOKEN_NOT_FOUND` if the token was never seen; `400` with code `INVALID_MINT` if the
mint is not a base58 address.

```json
{ "token": TokenView, "status": "passed", "screenings": [ScreeningView], "momentum": [MomentumPoint] }
```

### `GET /api/tokens/:mint/candles?interval=1m&limit=300`

OHLCV candles built from every stored trade of the token, oldest first. Buckets without
trades are omitted. `interval` defaults to `1m`; any other value than `1s`, `1m`, `5m`, `15m`, `1h` →
`400 INVALID_INTERVAL`. `limit` keeps the most recent N candles, default `300`, clamped to `1..2000`.
Same `INVALID_MINT` / `TOKEN_NOT_FOUND` errors as `/api/tokens/:mint`.

```json
{ "mint": string, "interval": "1m", "totalSupply": 1000000000, "solUsd": 142.31 | null,
  "candles": [Candle], "devTrades": [DevTrade] }
```

`solUsd` is the latest SOL/USD price from a free public source, or `null` if unavailable.

### `GET /api/tokens/:mint/stream`

Server-Sent Events for one token only. Same `INVALID_MINT` (400) error; an unknown but
valid mint is accepted (the token may appear later).

| Event | `data` | When |
| --- | --- | --- |
| `trade` | `TradeView` | Every stored trade of this token, as it happens (for 24 hours from its creation, see "Token cycle") |
| `sol-price` | `{ "solUsd": number }` | Once right after connecting (if known), then whenever it changes |

Heartbeat `: ping` every 15 seconds, like `/api/stream`.

### `GET /api/tokens?from=&to=&status=&lifecycle=&minScore=&sort=&page=&pageSize=`

Every token ever detected, from the database, newest first by default.

| Param | Default | Description |
| --- | --- | --- |
| `from`, `to` | none | ISO 8601 date or date-time (inclusive `from`, exclusive `to`) on `detectedAt`; clients send full instants at their local midnight, e.g. `2026-11-01T05:00:00.000Z` |
| `status` | all | `passed`, `failed`, `unverified`, `pending` (comma-separated allowed) |
| `lifecycle` | all | `active` or `dead` |
| `minScore` | none | Only tokens whose `maxScore` is at least this (0-100) |
| `q` | none | Case-insensitive match on symbol, name or mint prefix |
| `sort` | `detectedAt:desc` | `detectedAt`, `maxScore`, `peakMarketCapSol`, `liquidity` with `:asc` or `:desc` |
| `page`, `pageSize` | `1`, `50` | `pageSize` clamped to `1..200` |

Invalid values → `400 INVALID_QUERY` with a message naming the parameter.

```json
{ "tokens": [TokenListItem], "page": 1, "pageSize": 50, "total": 1234 }
```

### Token cycle

For every public token the platform stores its cycle: stable after appearing, explosion, peak, crash.
"Appeared" is the moment the token became public (the buy that reached the public conviction-wallet
minimum), not its creation. Everything is derived from trades seen so far (never from later data);
`peak*` and `maxDrawdownPct` keep updating while the token trades. Public tokens keep trade-by-trade
data for 24 hours from creation (`PUBLIC_TRACKING_HOURS`), so candles and the per-token stream work
for that long.

```ts
type CyclePhase = "stable" | "exploding" | "crashed";

interface TokenCycle {
  appearedAt: string;                 // when it became public in lessfomo
  launchPriceSol: number | null;      // first trade seen
  appearedPriceSol: number | null;    // base price: last trade at or before appearedAt
  riseBeforeAppearanceX: number | null;   // appearedPriceSol / launchPriceSol
  appearedLate: boolean;              // before appearing, price had already reached 2× its launch price
  phase: CyclePhase;                  // stable: not yet 2× base; exploding: reached 2× base; crashed: fell to ≤ 50% of its peak
  runStartAt: string | null;          // last trade before the explosion with price ≤ 1.2× base (appearedAt if none)
  explosionAt: string | null;         // first trade with price ≥ 2× base
  investWindowSeconds: number | null; // runStartAt − appearedAt (≥ 0) once exploded; negative when appearedLate
                                      // (seconds between the earlier 2× and appearing); null while stable and not late
  peakAt: string | null;              // maximum after the explosion
  peakX: number | null;               // peak price / base price
  crashAt: string | null;             // first trade with price ≤ 50% of the peak, after the peak
  maxDrawdownPct: number | null;      // 0-100, deepest fall from the peak so far
  lastPriceX: number | null;          // last price / base price
  updatedAt: string;
}
```

Details of the rules:

- Trades at or before `appearedAt` (trade times have one-second resolution) only set `launchPriceSol`,
  `appearedPriceSol` and `appearedLate`; the explosion, run-up, peak and crash come from later trades only.
  A late token still gets a phase, peak and crash from its base price; its `investWindowSeconds` stays
  negative (`0` when it reached 2× in the very second it appeared, so check `appearedLate` too).
- The peak is the maximum between the explosion and the crash. Once `crashed`, the cycle is complete:
  `peakAt`, `peakX` and `crashAt` no longer change; only `lastPriceX` and `maxDrawdownPct` (the fall
  from that peak) keep moving.
- After the 24 hours of trade-by-trade data, the cycle continues from the prices of the token's
  snapshots (coarser). A snapshot price only counts when the token had no stored trade in the 2
  minutes before it.
- A token without a cycle yet (it just became public, or the startup backfill has not reached it) has `cycle: null`.
- Ratios (`*X`) are rounded to 4 decimals, `maxDrawdownPct` to 2.

`Mover`, `TokenListItem` and `ScreeningView` gain `cycle: TokenCycle | null`, and `GET /api/tokens/:mint` gains a
top-level `cycle`. `GET /api/tokens` accepts `phase` (comma-separated `stable`, `exploding`, `crashed`),
`appearedLate` (`true`/`false`), the sort fields `appearedAt` and `investWindow`, and
`dateField` (`detectedAt`, the default, or `appearedAt`): with `appearedAt`, `from`/`to` filter on the
cycle's `appearedAt` instead of the creation time, and tokens without a cycle never match a range
(e.g. the tokens that appeared on one local day: `from=<midnight>&to=<next midnight>&dateField=appearedAt`).
Any other `dateField` → `400 INVALID_QUERY`. Candles accept
the intervals `15m` and `1h` too, and `limit` is clamped to `1..2000`.

| Event | Stream | `data` | When |
| --- | --- | --- | --- |
| `cycle` | `/api/stream` and `/api/tokens/:mint/stream` | `{ "mint": string, "cycle": TokenCycle }` | The token appears, its phase changes, or a new peak is set (at most once every 10 s per token) |

### `GET /api/analysis/cycles?from=&to=`

Aggregates over tokens that appeared in the range (default: last 7 days). No per-token data. Every `*Pct` field goes from 0 to 100.

```json
{ "from": string, "to": string, "tokens": 491,
  "appearedInTimePct": 0, "appearedLatePct": 0, "explodedPct": 0, "neverExplodedPct": 0, "crashedPct": 0,
  "medianInvestWindowSeconds": 0, "medianPeakX": 0, "medianSecondsToPeak": 0, "medianSecondsPeakToCrash": 0,
  "windowBuckets": [ { "label": "late" | "<1m" | "1-5m" | "5-15m" | "15-60m" | ">1h", "tokens": 0,
                       "medianPeakX": 0 } ] }
```

Statistics are `null` when there are no tokens to compute them from. `appearedInTimePct` +
`appearedLatePct` and `explodedPct` + `neverExplodedPct` each add up to 100; they and `crashedPct` are
shares of `tokens`. `medianInvestWindowSeconds` is over tokens that appeared in time and exploded;
`medianPeakX` and `medianSecondsToPeak` (from appearing to the peak) over tokens that exploded;
`medianSecondsPeakToCrash` over tokens that crashed. `windowBuckets` always lists the six labels in
that order: `late` holds every token that appeared late; the others hold tokens that appeared in time
and exploded, by `investWindowSeconds` (`<1m`: under 60 s, `1-5m`: 60 to under 300, `5-15m`: 300 to
under 900, `15-60m`: 900 to under 3600, `>1h`: 3600 or more); a bucket's `medianPeakX` is over its
tokens that exploded. In-time tokens that never exploded are in no bucket. It is aggregate-only and
computed over every stored cycle, like `/api/analysis/smart-wallets`.

### Public visibility rule

The public API only exposes tokens that have **at least `PUBLIC_MIN_CONVICTION_WALLETS` (default 3)
conviction wallets**: good-or-elite wallets whose point-in-time style at entry was `conviction`.
Flippers and mixed wallets are shown in token details but never make a token public. Every token-level endpoint and event applies it: `/api/movers`, `/api/screenings`,
`/api/tokens` (list), `/api/tokens/:mint`, `/candles`, `/snapshots`, `/smart-wallets`,
`/api/tokens/:mint/stream`, and the `token`, `screening`, `momentum`, `smart-wallet` and `cycle` events on
`/api/stream`. A token that does not qualify answers `404 TOKEN_NOT_FOUND` exactly as if it did not
exist, and is never included in lists or events. A token becomes visible as soon as it qualifies
(e.g. its 3rd conviction wallet buys it in minute 3); its per-token stream sends nothing until then.
`/api/wallets/:address` only lists results of qualifying tokens. `/api/stats` and
`/api/analysis/smart-wallets` remain aggregate-only and are computed over all stored data; they
never reveal individual non-qualifying tokens. Internal processes (reputation, snapshots, analysis)
keep using every stored token.

### Smart-wallet filters

`GET /api/tokens`, `GET /api/movers` and `GET /api/screenings` accept `minConvictionWallets` (an
integer, default `PUBLIC_MIN_CONVICTION_WALLETS` (3); integers below it are treated as it because of
the visibility rule; non-integers → `400 INVALID_QUERY`). `minSmartWallets` is still accepted as an
additional filter on good-or-elite wallets (an integer, default `0` = no filter, negative values
count as `0`; non-integers → `400 INVALID_QUERY`); it is no longer a visibility rule.
`/api/tokens` also accepts `sort=convictionWallets:desc` and `sort=smartWallets:desc`. Live SSE
events are unchanged; clients filter `momentum` movers by `smartWallets.conviction`, and a new SSE
event on `/api/stream` reports changes:

| Event | `data` | When |
| --- | --- | --- |
| `smart-wallet` | `{ "mint": string, "smartWallets": { count, elite, holding, conviction }, "wallet": SmartWalletInToken }` | A good-or-elite wallet buys or fully sells a token |

### `GET /api/tokens/:mint/smart-wallets`

```json
{ "mint": string, "smartWallets": [SmartWalletInToken] }   // elite first, then by entrySeconds
```

### `GET /api/wallets/:address`

Same `400 INVALID_MINT`-style validation for the address (code `INVALID_ADDRESS`); `404 WALLET_NOT_FOUND`.

```json
{ "record": WalletRecord, "results": [WalletTokenResult] }   // newest first, last 7 days, max 200
```

### `GET /api/analysis/smart-wallets?from=&to=&by=`

How success changes with the number of good-or-elite wallets (point-in-time tiers) that bought a
token within its live window. Buckets `0`, `1`, `2`, `3`, `4`, `5+`. Entry for each token in a bucket
is the price right after the k-th smart wallet's first buy (k = bucket size, `0` = the token's
safety-check time), exits at 2× or after 10 minutes, with a 3% round-trip cost.

`by` is `smartWallets` (default) or `conviction`; any other value → `400 INVALID_QUERY`. Every
response echoes `by`. With `by=conviction` tokens are bucketed by their conviction wallets at entry
(good-or-elite wallets whose point-in-time style at entry was `conviction`), the entry is the price
right after the k-th conviction wallet's first buy (`0` = the safety-check time), and each bucket
uses the key `convictionWallets` instead of `smartWallets` (same statistics fields).

```json
{ "from": string, "to": string, "by": "smartWallets", "costRoundTrip": 0.03,
  "buckets": [ { "smartWallets": "0", "tokens": 1234,
                 "reached2xPct": 3.1, "migratedPct": 0.4, "avgReturnPct": -4.2, "medianReturnPct": -6.0,
                 "winnersPct": 12.5, "medianPeakX": 1.1 } ] }
```

```json
{ "from": string, "to": string, "by": "conviction", "costRoundTrip": 0.03,
  "buckets": [ { "convictionWallets": "0", "tokens": 1234,
                 "reached2xPct": 3.1, "migratedPct": 0.4, "avgReturnPct": -4.2, "medianReturnPct": -6.0,
                 "winnersPct": 12.5, "medianPeakX": 1.1 } ] }
```

### `GET /api/tokens/:mint/snapshots`

All snapshots of a token, oldest first. Same `INVALID_MINT` / `TOKEN_NOT_FOUND` errors.

```json
{ "mint": string, "lifecycle": "active", "snapshots": [TokenSnapshot] }
```

### `GET /api/stats`

```json
{ "since": "2026-11-14T03:15:03.912Z",          // first token ever stored
  "tokens": { "total": 1234, "active": 210, "dead": 1024, "migrated": 3 },
  "screenings": { "passed": 80, "failed": 900, "unverified": 40, "pending": 214 },
  "trades": 456789, "snapshots": 23456 }
```

### `GET /api/stream`

[Server-Sent Events](https://developer.mozilla.org/docs/Web/API/Server-sent_events) stream.
Every event's `data` is JSON.

| Event | `data` | When |
| --- | --- | --- |
| `token` | `TokenView` | A new token is detected |
| `screening` | `ScreeningView` | A safety check finishes |
| `momentum` | `{ "at": string, "movers": Mover[] }` (top 20) | Every minute |
| `status` | `{ "sources": { "pumpportal": SourceStatus, "solanaLogs": SourceStatus } }` | Once right after connecting, then whenever a data source connects or disconnects |

A comment line (`: ping`) is sent every 15 seconds to keep the connection open.
