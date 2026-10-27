# SnapTrade API and DX feedback

Friction, surprises, and suggestions found while building ThesisDeploy on a SnapTrade OAuth app (October 2026), with what the app does about each one. Offered constructively: most of these cost us an afternoon, and a sentence in the docs or one field in a response would have saved it.

Status key: **docs/SDK** means found by reading the docs, the OpenAPI spec, or the SDK source, and handled defensively without seeing it in a live call. **confirmed** means seen in a live SnapTrade response.

## Top asks

1. **An OAuth mode in the TypeScript SDK**, with retries that are opt-in and honor `Retry-After`. Today an OAuth app has to bypass the SDK's auth and disable its hidden 429 loop by hand.
2. **A machine-readable capability answer per account**: "can this grant place orders here, and if not, why". Today it takes the grant's scopes, the connection's `type` and `disabled`, the brokerage's `allows_trading`, and the account list, joined on `connection_id`.
3. **Quotes outside the 10-per-minute account bucket**, or a bigger bucket for them. One ordinary user session (X-Ray, generate, pre-flight, valuation, rebalance) spends 8 account-scoped calls in about 10 seconds.
4. **`client_order_id` echoed on order records**, so an order whose placement timed out can be found exactly instead of heuristically.
5. **A trade-capable sandbox** with deterministic fills and failure injection. The SnapTrade Sandbox is read-only, so every app has to build its own order stub.

## OAuth and auth

### The TypeScript SDK has no OAuth (Bearer) auth mode
- **Date / source:** 2026-10-26, `snaptrade-typescript-sdk@13.1.11`, exercised offline with a stubbed HTTP adapter.
- **Observation:** `Snaptrade` and `Configuration` assume Commercial auth (`clientId`, `consumerKey`, request signing, `userId`/`userSecret`). OAuth calls need only `Authorization: Bearer <access token>`.
- **What we did:** construct the generated API classes without a `Configuration` and pass an axios instance that sets the Bearer header: `new TradingApi(undefined, baseUrl, bearerAxios)` (`lib/snaptrade/client.ts`). A test asserts that requests carry only that header.
- **Suggestion:** a first-class `new Snaptrade({ accessToken })` or `auth: "oauth"` option, plus an OAuth example in the SDK README.
- **Status:** docs/SDK

### The SDK retries 429s with hidden sleeps
- **Date / source:** 2026-10-26, `wrapAxiosRequest` in `snaptrade-typescript-sdk@13.1.11` (`dist/index.mjs`).
- **Observation:** on HTTP 429 the SDK `console.log`s, sleeps, and retries: 5s, 10s, then 20s (35s in total). It ignores `Retry-After`, and after the third 429 it throws a plain `Error` without the response or rate-limit headers. On serverless functions this silently burns duration and hides rate-limit pressure from the caller.
- **What we did:** set axios `validateStatus: () => true` so non-2xx responses never throw into the retry loop, and handle status codes and wait times in our own wrapper.
- **Suggestion:** make retries opt-in or configurable, honor `Retry-After`, and throw `SnaptradeError` (with headers) when retries are exhausted.
- **Status:** docs/SDK (read from source)

### Commercial-only concepts are easy to carry into an OAuth design
- **Date / source:** 2026-10-26, docs.
- **Observation:** our initial spec assumed `connectionType="trade"`, the Connection Portal, and the consumer key, all of which belong to the Commercial flow. On OAuth, trading depends on the `trade` scope plus an existing trade-type connection that the user manages in the SnapTrade Dashboard, and the scope does not upgrade a read-only connection. A token refresh doesn't add a scope either, so a user who signed in before `trade` was requested has to disconnect and sign in again.
- **Suggestion:** a short "Commercial vs. OAuth" table at the top of the OAuth guide listing which parameters and endpoints don't apply, and a sentence on how a user adds a scope later.
- **Status:** docs/SDK

### The discovery document advertises more than the guide documents
- **Date / source:** 2026-10-26, live `GET /.well-known/openid-configuration`, compared with the OAuth apps guide.
- **Observation:** the live metadata lists `trade`, `webhook`, and an undocumented `workspaces:read` in `scopes_supported`, while the guide's sample shows only `openid profile email read`. It also sets `authorization_response_iss_parameter_supported: true` (RFC 9207), but the guide's callback examples show only `code` and `state`, so it's unclear whether `iss` is always sent, including on error redirects.
- **What we did:** validate the metadata at runtime (issuer match, `S256`, `RS256`, every requested scope supported). A callback `iss` naming another issuer is rejected; a missing one is accepted, since the app trusts a single issuer.
- **Suggestion:** document `workspaces:read` (or drop it from the metadata) and show `iss` in the callback examples.
- **Status:** confirmed (metadata); `iss` on a real redirect not yet observed

### Rotating refresh tokens have no grace period
- **Date / source:** 2026-10-26, OAuth apps guide ("replace atomically").
- **Observation:** each refresh invalidates the previous refresh token. On serverless, two requests for the same user can find an expiring access token at the same moment; without coordination, the second refresh uses a dead token and the user is signed out.
- **What we did:** refresh inside a Postgres transaction that locks the grant row and re-checks expiry once it holds the lock (`lib/auth/vault.ts`), so each refresh token is spent exactly once. An integration test runs concurrent refreshes against a stub that enforces rotation.
- **Suggestion:** a short reuse window for the previous refresh token (many providers allow a few seconds), or a note in the guide recommending a lock like this.
- **Status:** docs/SDK

### The Test OAuth app is capped at 5 users
- **Date / source:** 2026-10-26, OAuth apps guide.
- **Observation:** a hosted take-home or demo shared with a review panel can exceed 5 users, and a Production OAuth app requires KYC.
- **What we did:** a no-login guest demo on fictional fixture data that runs the whole product (generation, pre-flight, paced paper runs, rebalance, close, telemetry) without a SnapTrade account.
- **Status:** docs/SDK

## Rate limits

### The per-account limit is tight for a multi-step flow
- **Date / source:** 2026-10-27, our end-to-end smoke test against a stub that enforces the documented 10-per-minute account window.
- **Observation:** balances, positions, quotes, and orders share one 10-per-minute bucket per account. A user who opens Portfolio X-Ray (2 calls), generates a basket (1 quotes call), runs pre-flight (1), opens My Theses (1), and starts a rebalance (1) has spent 6–8 calls; a fast walk-through does it in about 10 seconds. The next step then has to wait up to a minute.
- **What we did:** cache balances and positions for 10 minutes, batch quotes into one call per basket, cache basket marks for 60 seconds, and keep our own budget (8 of 10 per rolling minute, counted across serverless instances in `api_calls`) so the app tells the user how long to wait instead of reaching a 429. The smoke test shows the message and a cached view, never an error page.
- **Suggestion:** put quotes in their own bucket (they're the call a trading flow repeats), or publish a higher limit for batched quotes.
- **Status:** docs/SDK (limit documented; behavior reproduced against our stub)

### The per-user OAuth limit is undocumented
- **Date / source:** 2026-10-26, rate-limiting docs.
- **Observation:** OAuth requests skip the 250/min customer limit but are subject to 10/min per account on account-data endpoints and an additional per-user limit that has no published number and sends no headers.
- **What we did:** caching and batching as above, and every 429 is surfaced with its wait time rather than retried.
- **Suggestion:** publish the per-user limit or return `X-RateLimit-*` headers for it.
- **Status:** docs/SDK

### 429s carry the wait time in reset headers and body text, not `Retry-After`
- **Date / source:** 2026-10-26, rate-limiting docs.
- **Observation:** the docs describe `X-RateLimit-Reset` and `X-RateLimit-Account-Reset` (customer and account layers) and a body like `"Request was throttled. Expected available in 7 seconds."`. Clients have to work out which layer was exhausted from the two `*-Remaining` headers, or parse the sentence.
- **What we did:** use `Retry-After` if present, then the reset header of the exhausted layer, then the body text.
- **Suggestion:** send a standard `Retry-After` header on 429s, and a machine-readable field naming the exhausted layer.
- **Status:** docs/SDK

### Symbol search and quotes sit in different rate-limit buckets
- **Date / source:** 2026-10-27, rate-limiting docs.
- **Observation:** `getUserAccountQuotes` is on the list of account-limited endpoints, but `symbolSearchUserAccount` (also `/accounts/{accountId}/...`) is not. An app grounding tickers would naturally treat both the same way; knowing which one is free changes the design.
- **What we did:** quotes go through our per-account budget and symbol search doesn't; both are recorded in `api_calls`.
- **Suggestion:** mark each endpoint's bucket in the API reference.
- **Status:** docs/SDK

## Accounts and positions

### Trading capability takes four sources to work out
- **Date / source:** 2026-10-26, OpenAPI schemas.
- **Observation:** whether an account can take an order depends on the grant's `trade` scope, the connection's `type` (`read` or `trade`) and `disabled`, the brokerage's `allows_trading`, and the account itself. They live on three different objects, and brokerage-level support doesn't guarantee account-level permission.
- **What we did:** compute one capability per account (Trading, Read-only with the reason, or Disabled with a link to the SnapTrade Dashboard) and use it for the X-Ray badge and the Live gate.
- **Suggestion:** a `trading` object on each account (`{ allowed: boolean, reason: "scope" | "read_only_connection" | "disabled" | "brokerage" | … }`).
- **Status:** docs/SDK

### The unified account list has no institution name or open/closed status
- **Date / source:** 2026-10-26, `InvestmentAccount` in `snaptrade-typescript-sdk@13.1.11` (`listAllUserAccounts`).
- **Observation:** each entry has `connection_id`, `display_name`, `masked_account_number`, `is_paper`, and `cash_or_margin`, but not the institution's name or a `status` (the older `Account` model had `status: open | closed | archived | unavailable`). Showing "Questrade · ****4821" requires a second call (`listBrokerageAuthorizations`) and a join on `connection_id`, and closed accounts can't be filtered out.
- **What we did:** join connections and accounts on every page load. Both calls are cheap, since they aren't account-scoped and the account list is Daily-cached.
- **Suggestion:** include `institution_name` (or the brokerage slug) and `status` on each account.
- **Status:** docs/SDK

### Numbers arrive as strings in some models and numbers in others
- **Date / source:** 2026-10-26, `getAllAccountPositions` and `getUserAccountBalance` in the SDK types.
- **Observation:** position `units` and `price` are strings, while balances and quotes are numbers. Each model needs its own parsing, and a missed one becomes string concatenation in a sum.
- **What we did:** one `parseNumber` at the normalization boundary (`lib/portfolio/normalize.ts`); everything past it is numeric.
- **Suggestion:** document why (decimal precision is a good reason) and apply it consistently, or offer both.
- **Status:** docs/SDK

## Trading and market data

### Order impact needs a universal symbol ID; placing an order recommends the ticker
- **Date / source:** 2026-10-27, `getOrderImpact` and `placeForceOrder` references, and the symbology guide.
- **Observation:** the guide says universal symbol IDs aren't stable and recommends placing orders by `symbol`, but `getOrderImpact` requires `universal_symbol_id`. Previewing and placing the same order therefore use two identifiers, one of which may have changed since it was resolved.
- **What we did:** resolve the ID from a fresh quotes call at pre-flight, use it for the preview, and place orders by ticker.
- **Suggestion:** accept `symbol` on `getOrderImpact` too.
- **Status:** docs/SDK

### Order impact doesn't say how "no preview" looks
- **Date / source:** 2026-10-27, order impact guide and OpenAPI spec.
- **Observation:** the guide says preview support is separate from trading support, and an app must label impact as "not available" when there's no preview. But the reference doesn't say what `getOrderImpact` returns for a brokerage that has no preview, as opposed to an order the broker would refuse. Both may arrive as a 4xx with a `detail` string.
- **What we did:** HTTP 404, 405, or 501, or a `detail` matching "not supported", is treated as no preview: Live stays available, labeled "Not available". Any other 4xx is a refusal that blocks Live with the broker's message.
- **Suggestion:** a distinct error code (or a per-connection capability flag) for "impact not supported".
- **Status:** docs/SDK; to be checked on Alpaca Paper

### `client_order_id` isn't echoed in order records
- **Date / source:** 2026-10-27, `AccountOrderRecord` in `snaptrade-typescript-sdk@13.1.11` and the place-order reference.
- **Observation:** `placeForceOrder` accepts a `client_order_id`, which SnapTrade forwards and the broker may use to deduplicate. But neither recent orders nor order detail returns it. When placement times out or returns a 5xx, the order may or may not exist, and the only way to find it is to match on symbol, side, quantity, and `time_placed`.
- **What we did:** such a leg is `unknown` and never resent automatically. Reconciliation matches it heuristically; if nothing matches, the user confirms it isn't at the broker before a new attempt (with a new `client_order_id`) goes out.
- **Suggestion:** return `client_order_id` on `AccountOrderRecord`, or add a lookup by it.
- **Status:** docs/SDK

### Recent orders default to executed orders only
- **Date / source:** 2026-10-26, `getUserAccountRecentOrders` reference.
- **Observation:** `only_executed` defaults to `true`, so an app checking on orders it just placed sees nothing for accepted or pending orders unless it knows to pass `false`. Some brokerages also answer 501, which means a second code path through order detail.
- **What we did:** always pass `only_executed=false`; on 404, 405, or 501, fall back to `getUserAccountOrderDetail` for up to 3 open legs. Checks are throttled to one per 15 seconds per execution.
- **Suggestion:** call the default out in the reference's first line, and list which brokerages lack recent orders in the institution support table.
- **Status:** docs/SDK

### Off-hours behavior for Market/Day orders is not documented
- **Date / source:** 2026-10-26, trading docs.
- **Observation:** whether a brokerage queues or rejects a Market/Day order outside the regular session is brokerage-specific and not listed, and there is no market-calendar endpoint.
- **What we did:** ship our own NYSE/TSX calendar (`lib/market-hours.ts`, holidays through 2027) and block Live outside regular hours, re-checked at confirm.
- **Suggestion:** per-brokerage off-hours behavior in the institution support table, or a market-status endpoint.
- **Status:** docs/SDK

### Quote behavior for unknown tickers is unspecified
- **Date / source:** 2026-10-26, `getUserAccountQuotes` reference.
- **Observation:** the reference doesn't say whether an invalid ticker in a `use_ticker=true` batch is omitted from the response or fails the whole call. This matters when grounding LLM-proposed tickers.
- **What we did:** handle both. Tickers missing from the response go to `symbolSearchUserAccount`; if the batch fails with 400, 404, or 422, every candidate is searched and the confirmed tickers are quoted once more, which costs a second call against the account's limit.
- **Suggestion:** document the behavior, and ideally return a per-symbol error list so one bad ticker can't sink the batch.
- **Status:** docs/SDK; to be checked against a live account

### There's no trade-capable sandbox
- **Date / source:** 2026-10-26, sandbox docs.
- **Observation:** the SnapTrade Sandbox is read-only, so the only way to exercise orders end to end is Alpaca Paper, which needs a real Alpaca account, market hours, and gives no control over outcomes. Partial fills, rejections, and a placement that succeeds but times out can't be produced on demand.
- **What we did:** a local stub (`scripts/snaptrade-api-stub.mjs`) that implements impact, place, recent orders, and order detail with switchable outcomes (accept, fill, partial, never fill, reject, place-then-fail), used by the Live integration tests. One manual run on Alpaca Paper covers the real path.
- **Suggestion:** a sandbox brokerage that accepts orders at any hour, fills deterministically, and takes a test header to force a rejection, partial fill, or delayed fill.
- **Status:** docs/SDK
