# SnapTrade API and DX feedback

A running log of friction, surprises, and suggestions found while building ThesisDeploy on a SnapTrade OAuth app. Add entries as you hit them; note the date, where it came from (docs, SDK, or a live call), and what we did about it.

Status key: **docs/SDK** means found by reading the docs, the OpenAPI spec, or the SDK source, not yet seen in a live call. **confirmed** means reproduced against the API.

## OAuth and auth

### The TypeScript SDK has no OAuth (Bearer) auth mode
- **Date / source:** 2026-10-26, `snaptrade-typescript-sdk@13.1.11`, exercised offline with a stubbed HTTP adapter.
- **Observation:** `Snaptrade` and `Configuration` assume Commercial auth (`clientId`, `consumerKey`, request signing, `userId`/`userSecret`). OAuth calls need only `Authorization: Bearer <access token>`.
- **Workaround:** construct the generated API classes without a `Configuration` and pass an axios instance that sets the Bearer header, e.g. `new TradingApi(undefined, undefined, bearerAxios)`.
- **Suggestion:** a first-class `new Snaptrade({ accessToken })` or `auth: "oauth"` option, plus an OAuth example in the SDK README.
- **Status:** docs/SDK

### The SDK retries 429s with hidden sleeps
- **Date / source:** 2026-10-26, `wrapAxiosRequest` in `snaptrade-typescript-sdk@13.1.11` (`dist/index.mjs`).
- **Observation:** on HTTP 429 the SDK `console.log`s, sleeps, and retries: 5s, 10s, then 20s (35s in total). It ignores `Retry-After`, and after the third 429 it throws a plain `Error` without the response or rate-limit headers. On serverless functions this silently burns duration and hides rate-limit pressure from the caller.
- **Workaround:** set axios `validateStatus: () => true` so 429s never throw into the retry loop, and handle status codes and `Retry-After` in our own wrapper.
- **Suggestion:** make retries opt-in or configurable, honor `Retry-After`, and throw `SnaptradeError` (with headers) when retries are exhausted.
- **Status:** docs/SDK (read from source; not yet triggered live)

### Commercial-only concepts are easy to carry into an OAuth design
- **Date / source:** 2026-10-26, docs.
- **Observation:** our initial spec assumed `connectionType="trade"`, the Connection Portal, and the consumer key, all of which belong to the Commercial flow. On OAuth, trading depends on the `trade` scope plus an existing trade-type connection that the user manages in the SnapTrade Dashboard, and the scope does not upgrade a read-only connection.
- **Suggestion:** a short "Commercial vs. OAuth" table at the top of the OAuth guide listing which parameters and endpoints do not apply.
- **Status:** docs/SDK

### The discovery document advertises more than the guide documents
- **Date / source:** 2026-10-26, live `GET /.well-known/openid-configuration` (the only live SnapTrade call made so far) compared with the OAuth apps guide.
- **Observation:** the live metadata lists `trade`, `webhook`, and an undocumented `workspaces:read` in `scopes_supported`, while the guide's sample shows only `openid profile email read`. It also sets `authorization_response_iss_parameter_supported: true` (RFC 9207), but the guide's callback examples show only `code` and `state`, so it is unclear whether `iss` is always sent, including on error redirects.
- **What we did:** validate the metadata at runtime (issuer match, `S256`, `RS256`, every requested scope supported). A callback `iss` that names another issuer is rejected; a missing one is accepted, since the app trusts a single issuer.
- **Suggestion:** document `workspaces:read` (or drop it from the metadata) and show `iss` in the callback examples.
- **Status:** confirmed (metadata); `iss` behavior not yet seen on a real redirect

### The Test OAuth app is capped at 5 users
- **Date / source:** 2026-10-26, OAuth apps guide.
- **Observation:** a hosted take-home or demo shared with a review panel can exceed 5 users, and a Production OAuth app requires KYC.
- **Mitigation:** a no-login guest demo on fixture data.
- **Status:** docs/SDK

## Rate limits

### The per-user OAuth limit is undocumented
- **Date / source:** 2026-10-26, rate-limiting docs.
- **Observation:** OAuth requests skip the 250/min customer limit but are subject to 10/min per account on account-data endpoints and an additional per-user limit that has no published number and sends no headers.
- **Workaround:** cache account snapshots for 10 minutes, batch quotes into one call per basket, and honor `Retry-After` with exponential backoff and jitter.
- **Suggestion:** publish the per-user limit or return `X-RateLimit-*` headers for it.
- **Status:** docs/SDK

### 429s carry the wait time in reset headers and body text, not `Retry-After`
- **Date / source:** 2026-10-26, rate-limiting docs.
- **Observation:** the docs describe `X-RateLimit-Reset` and `X-RateLimit-Account-Reset` (customer and account layers) and a body like `"Request was throttled. Expected available in 7 seconds."`. Clients have to work out which layer was exhausted from the two `*-Remaining` headers, or parse the sentence.
- **What we did:** use `Retry-After` if present, then the reset header of the exhausted layer, then the body text. We also keep our own per-account budget (8 of 10 per rolling minute, shared through `api_calls`) so the app rarely reaches a 429.
- **Suggestion:** send a standard `Retry-After` header on 429s, and a machine-readable field naming the exhausted layer.
- **Status:** docs/SDK

## Accounts and positions

### The unified account list has no institution name or open/closed status
- **Date / source:** 2026-10-26, `InvestmentAccount` in `snaptrade-typescript-sdk@13.1.11` (`listAllUserAccounts`).
- **Observation:** each entry has `connection_id`, `display_name`, `masked_account_number`, `is_paper`, and `cash_or_margin`, but not the institution's name or a `status` (the older `Account` model had `status: open | closed | archived | unavailable`). Showing "Questrade · ****4821" requires a second call (`listBrokerageAuthorizations`) and a join on `connection_id`, and closed accounts can't be filtered out.
- **What we did:** join connections and accounts on every page load. Both calls are cheap, since they aren't account-scoped and the account list is Daily-cached.
- **Suggestion:** include `institution_name` (or the brokerage slug) and `status` on `ConnectionAccount`.
- **Status:** docs/SDK

## Trading and market data

### Off-hours behavior for Market/Day orders is not documented
- **Date / source:** 2026-10-26, trading docs.
- **Observation:** whether a brokerage queues or rejects a Market/Day order outside the regular session is brokerage-specific and not listed, and there is no market-calendar endpoint.
- **Workaround:** ship our own NYSE/TSX calendar and block Live mode outside regular hours.
- **Suggestion:** per-brokerage off-hours behavior in the institution support table, or a market-status endpoint.
- **Status:** docs/SDK

### Quote behavior for unknown tickers is unspecified
- **Date / source:** 2026-10-26, `getUserAccountQuotes` reference.
- **Observation:** the reference does not say whether an invalid ticker in a `use_ticker=true` batch is omitted from the response or fails the whole call. This matters when grounding LLM-proposed tickers.
- **Next step:** verify against a live account and update this entry.
- **Status:** docs/SDK
