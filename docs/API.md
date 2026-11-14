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
```

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
