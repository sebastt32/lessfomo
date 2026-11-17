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

type CandleInterval = "1s" | "1m" | "5m";

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
  record: WalletRecord;           // current record, to explain why it is good
  firstBuyAt: string; entrySeconds: number;
  boughtSol: number; soldSol: number;
  stillHolding: boolean;          // positive balance per observed trades
}
```

`Mover`, `TokenListItem` and `ScreeningView` gain `smartWallets: { count: number; elite: number; holding: number }`
(good-or-elite wallets, by tier at entry, that bought the token; `holding` = still holding).

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
trades are omitted. `interval` defaults to `1m`; any other value than `1s`, `1m`, `5m` →
`400 INVALID_INTERVAL`. `limit` keeps the most recent N candles, default `300`, clamped to `1..1000`.
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
| `trade` | `TradeView` | Every trade of this token, as it happens |
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

### Public visibility rule

The public API only exposes tokens that have **at least one good-or-elite wallet** (point-in-time
tier at entry). Every token-level endpoint and event applies it: `/api/movers`, `/api/screenings`,
`/api/tokens` (list), `/api/tokens/:mint`, `/candles`, `/snapshots`, `/smart-wallets`,
`/api/tokens/:mint/stream`, and the `token`, `screening`, `momentum` and `smart-wallet` events on
`/api/stream`. A token that does not qualify answers `404 TOKEN_NOT_FOUND` exactly as if it did not
exist, and is never included in lists or events. A token becomes visible as soon as it qualifies
(e.g. a good wallet buys it in minute 3); its per-token stream sends nothing until then.
`/api/wallets/:address` only lists results of qualifying tokens. `/api/stats` and
`/api/analysis/smart-wallets` remain aggregate-only and are computed over all stored data; they
never reveal individual non-qualifying tokens. Internal processes (reputation, snapshots, analysis)
keep using every stored token.

### Smart-wallet filters

`GET /api/tokens` and `GET /api/movers` accept `minSmartWallets` (an integer, default `1`; integers
below 1 are treated as 1 because of the visibility rule; non-integers → `400 INVALID_QUERY`) and
`/api/tokens` also accepts `sort=smartWallets:desc`. `GET /api/screenings` accepts `minSmartWallets`
too. Invalid values → `400 INVALID_QUERY`. Live SSE events are unchanged; clients filter `momentum`
movers by `smartWallets.count`, and a new SSE event on `/api/stream` reports changes:

| Event | `data` | When |
| --- | --- | --- |
| `smart-wallet` | `{ "mint": string, "smartWallets": { count, elite, holding }, "wallet": SmartWalletInToken }` | A good-or-elite wallet buys or fully sells a token |

### `GET /api/tokens/:mint/smart-wallets`

```json
{ "mint": string, "smartWallets": [SmartWalletInToken] }   // elite first, then by entrySeconds
```

### `GET /api/wallets/:address`

Same `400 INVALID_MINT`-style validation for the address (code `INVALID_ADDRESS`); `404 WALLET_NOT_FOUND`.

```json
{ "record": WalletRecord, "results": [WalletTokenResult] }   // newest first, last 7 days, max 200
```

### `GET /api/analysis/smart-wallets?from=&to=`

How success changes with the number of good-or-elite wallets (point-in-time tiers) that bought a
token within its live window. Buckets `0`, `1`, `2`, `3`, `4`, `5+`. Entry for each token in a bucket
is the price right after the k-th smart wallet's first buy (k = bucket size, `0` = the token's
safety-check time), exits at 2× or after 10 minutes, with a 3% round-trip cost.

```json
{ "from": string, "to": string, "costRoundTrip": 0.03,
  "buckets": [ { "smartWallets": "0", "tokens": 1234,
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
