# SnapTrade client and Portfolio X-Ray

Portfolio X-Ray (`/portfolio`) shows each connected investment account's cash and buying power per currency, its positions, and a concentration bar. `/demo` renders the same screen from fictional fixture data with no sign-in.

## SnapTrade client (`lib/snaptrade/client.ts`)

- **Bearer-only requests.** The TypeScript SDK (`snaptrade-typescript-sdk@13.1.11`) has no OAuth mode, so the client builds `AccountInformationApi` and `ConnectionsApi` without a `Configuration` and passes an axios instance that sets `Authorization: Bearer <access token>`. Requests go to SnapTrade's canonical root paths (`/accounts/all`, not the deprecated `/api/v1/...`) with no Commercial query parameters or signatures. A unit test asserts this against a stub server.
- **No hidden retries.** `validateStatus: () => true` hands every response back to the wrapper, so the SDK's built-in 429 retry loop (sleeps of 5s, 10s, and 20s) never runs. The timeout is 15s.
- **`callSnapTrade(ctx, operation, request, { accountId })`** gets the user's access token from the vault and calls one endpoint:
  - **401:** refreshes the token once (`getAccessToken(..., { staleAccessToken })`) and retries once. A second 401 deletes the grant and raises `ReauthRequiredError`, and the page asks the user to sign in again.
  - **429:** never retried. It becomes `SnapTradeError("rate_limited")` with a wait time taken from `Retry-After`, the exhausted layer's `X-RateLimit-*-Reset` header, or SnapTrade's documented body ("Expected available in N seconds").
  - **Other non-2xx and network failures:** become `SnapTradeError("upstream" | "network")`.
- **`api_calls` telemetry.** Every attempt is recorded: operation, brokerage slug, HTTP status (`null` when no response arrived), latency, `X-Request-ID`, and `X-RateLimit-Account-Remaining`. Account IDs are stored only as a keyed hash.

## Staying inside the per-account limit

SnapTrade allows 10 requests per minute per account on account-data endpoints, as a rolling window shared by balances, positions, orders, and quotes ([rate limiting](https://docs.snaptrade.com/docs/ratelimiting)).

- **Shared budget** (`lib/snaptrade/rate-budget.ts`). Before an account-scoped call, the client counts that account's calls in `api_calls` over the trailing 60 seconds. Every serverless instance writes to the same table, and only this app uses its OAuth client ID, so the count covers every call that SnapTrade counts. The client stops at 8, leaving headroom for concurrent requests, and also stops whenever the last response reported `X-RateLimit-Account-Remaining: 0`. Blocked calls fail locally with a wait time and never reach SnapTrade.
- **Snapshot cache.** Balances and positions are cached per user and account in `account_snapshots` for 10 minutes. **Refresh** forces a fetch. When a fetch is blocked or SnapTrade is unreachable, the last snapshot is shown with a notice instead of an error. Disconnecting SnapTrade deletes the cached snapshots.
- **Coalescing.** Identical concurrent loads share one set of calls. This matters because Next.js 16 renders `/portfolio` twice per request with Partial Prefetching enabled; double submits and extra tabs would otherwise do the same.
- A live snapshot costs two account-scoped calls (balances and positions). The connection and account lists aren't account-scoped.

## What the screen shows

| Section | Source | Notes |
|---|---|---|
| Account selector | `listBrokerageAuthorizations` + `listAllUserAccounts` | Investment accounts only; other kinds are counted but hidden. The institution comes from the connection. |
| Capability badge | Connection `type`, `disabled`, `brokerage.allows_trading`, and the grant's `trade` scope | **Trading**, **Read-only** (with the reason), or **Disabled** (with a link to the SnapTrade Dashboard). Paper and margin accounts are labeled. |
| Cash and buying power | `getUserAccountBalance` | One row per currency, never converted. A missing buying power is shown as "not reported". |
| Concentration | Positions + cash | One bar per currency (no FX): top 5 holdings, the rest grouped, then cash. `cash_equivalent` positions are already inside cash, so they aren't counted twice. Shorts and negative margin cash are left out. |
| Positions | `getAllAccountPositions` | `units` and `price` arrive as strings and are parsed. Weight is the share of same-currency holdings plus cash. |

## Testing locally without SnapTrade

`scripts/snaptrade-api-stub.mjs` serves `lib/portfolio/demo-fixtures.json` on the four endpoints. It requires a Bearer token and enforces the rolling 10-per-minute account limit with SnapTrade's headers and 429 body.

```bash
npm run dev:oauth-stub   # http://127.0.0.1:4010 (see docs/sign-in.md)
npm run dev:api-stub     # http://127.0.0.1:4020
# .env.local: the stub sign-in variables plus
SNAPTRADE_API_BASE_URL=http://127.0.0.1:4020
```

`lib/snaptrade/client.integration.test.ts` covers caching, coalescing, 401 refresh and re-auth, 429 handling, staying under the account limit across repeated refreshes, serving cached data when SnapTrade is unreachable, and clearing snapshots on disconnect. It runs against both stubs and Postgres when `TEST_DATABASE_URL` is set, as it is in CI.

## Manual test with a real SnapTrade account

After signing in with SnapTrade (see [`docs/sign-in.md`](sign-in.md)):

1. **Open the screen.** Click **Open Portfolio X-Ray**, or go to `/portfolio`. Every investment account you can see in the SnapTrade Dashboard is listed with its institution and masked number. Alpaca Paper shows **Trading** and **Paper**; a read-only connection shows **Read-only** with the reason.
2. **Check one account against its brokerage.** Pick an account and compare cash and buying power per currency, and each position's units and price, with the brokerage or the SnapTrade Dashboard. The concentration bars should add up to 100% per currency.
3. **Check the cache.** Reload within 10 minutes. The header says "cached", and `select operation, http_status from api_calls order by id desc limit 6` shows no new balance or position calls.
4. **Exercise the budget.** Click **Refresh** five times quickly. The first few say "Refreshed from SnapTrade"; then a notice says the account's request limit is used up and gives a wait time. `api_calls` should show no `429` rows, because the budget stops before SnapTrade does.
5. **Check telemetry privacy.** `select account_hash from api_calls where account_hash is not null limit 3` shows hashes, never SnapTrade account IDs.
6. **Disconnect.** Click **Disconnect SnapTrade** on the home page, then run `select count(*) from account_snapshots`. It should return 0.
7. **Guest demo.** Open `/demo` in a private window. It works without signing in, and every account and position in it is fictional.
