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
