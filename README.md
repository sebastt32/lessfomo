# lessfomo

Real-time memecoin screener for Solana. It detects new tokens, enriches them with
on-chain and market data, and discards the ones that fail basic safety checks.

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

## Pipeline

```
New token detector (WebSocket)
        ↓
Enrichment (RPC + RugCheck + DexScreener)
        ↓
Rules engine → score (discard on any failed safety check)
        ↓
Storage + real-time dashboard / alerts
```

> Passing the filters does not make a token profitable. It only removes obvious scams.
