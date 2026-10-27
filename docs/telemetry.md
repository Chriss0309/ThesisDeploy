# Product telemetry

"► Product telemetry" in every page footer opens a drawer with the numbers behind the product: whether people get from sign-in to a deployed basket, whether they trust ThesisDeploy's baskets as suggested, and how SnapTrade behaves. It reads the `events` and `api_calls` tables, covers the last 30 days, and shows two views:

- **Everyone:** every signed-in user and demo visitor. It's cached for a minute per server instance.
- **You:** the current SnapTrade sign-in plus this browser's demo cookie. A signed-out reviewer on `/demo` sees their own demo run here.

`GET /api/telemetry` returns both views in one response (aggregates only, `Cache-Control: no-store`), so switching between them is instant. Without a database it answers `503 not_configured`.

## Metrics

| Metric | Computed from | Definition |
|---|---|---|
| Activation funnel | `oauth_connected`, `thesis_generated`, `basket_deployed`, then `drift_viewed`, `rebalance_confirmed`, `basket_closed` | Distinct people per step. A signed-in person enters by connecting within the window; a guest enters with their first basket, because guests never sign in. A later step counts only people who reached the earlier one, so the funnel never widens. Each step shows its conversion from the previous step, and each cohort shows its end-to-end rate and basket counts. Under it, "Then in My Theses" counts the people who deployed and went on to view drift, rebalance, or close. |
| Basket edit rate | `basket_edited`, `symbols_resolved.resolved` | Suggested tickers removed or resized (weight slider or share stepper) in the Basket Composer before pre-flight, divided by tickers shown. A ticker counts once per basket, and one removed and then restored doesn't count. |
| Symbol resolution hit rate | `symbols_resolved` | Tickers ThesisDeploy proposed that grounding resolved to a tradeable, priced listing in the basket currency, per basket shown, with the drop reasons. Signed-in baskets are grounded against SnapTrade and demo baskets against the fixture price feed, so they're reported separately. |
| Order success by brokerage | `leg_result` | Leg attempts that were executed, accepted, or partially filled, divided by every attempt with a result, per brokerage slug and mode, across deploys, rebalances, and closes, with the split by kind. Legs recorded without a kind predate My Theses and count as deploys. A retry is a second order. A Live attempt reports again each time a status check finds it changed, so each attempt (`legId`) counts once, with its latest result: an order the broker accepted and later filled is one success. A `pending` result (a 429 put the leg back) isn't counted yet. Guest legs run on fictional accounts, so they're grouped as "Demo accounts" whatever brokerage the fixture names. |
| SnapTrade latency | `api_calls` | p50 and p95 (`percentile_cont`) of `latency_ms` per operation, over every call made through the Bearer client, including failures and timeouts. Calls and failures are shown per operation. |
| Rate limits | `api_calls.http_status = 429` | SnapTrade 429 responses, out of all calls, with the most recent one. The client budgets account-scoped calls below SnapTrade's 10 per minute per account and never retries a 429 automatically, so any 429 here is worth a look. |

## Events

Emitted server-side unless noted. Guest events carry `guest_key`, the keyed hash of the `td_guest` demo cookie that `baskets.guest_key` already stores; signed-in events carry `user_id`.

| Event | When | Notable props |
|---|---|---|
| `oauth_started`, `oauth_connected`, `oauth_denied`, `oauth_disconnected` | Sign-in and disconnect | scopes, `trade` |
| `accounts_loaded` | Each account list read from SnapTrade | accounts, hidden accounts |
| `thesis_generated` | **Once per basket shown**, signed in or guest | `source` (`generated`, `cached`, or `sample`), `ref`, `guest`, preset, model; latency and tokens only when `source` is `generated` |
| `symbols_resolved` | With every `thesis_generated` | `source`, `ref`, proposed, resolved, dropped by reason |
| `basket_edited` | Composer edits (browser, debounced) | `thesisId` (signed in) or `ref` (guest), action (`remove`, `restore`, `reweight`, `step`), symbol |
| `preflight_opened`, `execution_confirmed`, `leg_result`, `basket_deployed`, `execution_canceled` | Paper and Live execution (see [`paper-execution.md`](paper-execution.md) and [`live-execution.md`](live-execution.md)) and My Theses rebalances and closes | kind (`deploy`, `rebalance`, `close`), mode, `leg_result` leg, action, status, brokerage slug, error code, `source` (`submit` or `reconcile`), guest |
| `impact_checked` | A Live pre-flight's brokerage preview | kind, mode, brokerage slug, legs, source, rejections, latency |
| `drift_viewed` | My Theses opened with at least one priced, active basket (`/theses` or `/demo/theses`) | baskets, flagged, max drift in points |
| `rebalance_confirmed` | A rebalance pre-flight confirmed | sells, buys, drift before and after, proceeds, cost |
| `basket_closed` | A close run sells the last share | orders, filled, failed |

Three gaps that skewed the drawer were closed when it was built:

- **Cached and sample demo baskets emitted nothing.** Most guests get a cached preset, so guests deployed baskets the funnel never saw generated. `thesis_generated` and `symbols_resolved` now fire once per basket shown, with a `source`. The guest path no longer emits them inside the shared generation job: a caller that joins someone else's in-flight generation records `cached`, so tokens are never counted twice.
- **Guest events had no owner.** The demo cookie is now issued with the first demo basket (it used to come in that response, after the events were written), and every guest event records its hash in `events.guest_key`.
- **Guest composer edits weren't recorded.** `POST /api/demo/edits` takes `{ ref, action, symbol }`. It accepts a `ref` only if `thesis_generated` served that basket to the same cookie in the last day. The signed-in route is unchanged.

My Theses events follow the same ownership rule: on `/demo/theses`, `drift_viewed`, the rebalance and close pre-flights, confirmations, legs, and `basket_closed` all carry the demo cookie's hash, so a guest's whole lifecycle shows up in "You".

## Privacy

- The drawer returns aggregates only, never rows, request IDs, or account hashes.
- Account IDs reach telemetry only as keyed hashes (`api_calls.account_hash`). Guests are keyed by a hash of their cookie, never the cookie itself or their IP.
- Tokens, authorization codes, account numbers, and the client secret are never written to `events` or `api_calls`.

## Cost

Every query is bounded by the 30-day window and served by an index:

- `events`: `(name, created_at)`, `(user_id)`, and the new `(guest_key, created_at)`.
- `api_calls`: `(user_id)` and the new `(created_at)`, which serves the Everyone scan across operations.

Each view is six small aggregate queries run in parallel, or five for a guest-only view, which has no SnapTrade calls to read. Everyone is computed at most once a minute per instance, and concurrent requests share the computation. The migration `20261027065454_telemetry_drawer` adds one nullable column and two indexes.

## Tests

- `lib/telemetry/metrics.integration.test.ts` runs against Postgres (`TEST_DATABASE_URL`). It checks every metric against a seeded scenario with known answers: funnel monotonicity and the window, My Theses activity counted only after a deploy, rebalance and close legs split by kind, the remove-then-restore rule, hit rate by source, `pending` excluded from orders, exact percentiles, and 429s. It also checks scoping to one user or one cookie, and the one-minute cache. It then runs a whole guest demo (sample basket, edit, pre-flight, paper run with a rejected leg and its retry) and asserts every event is attributed to the cookie. A Live scenario checks that an attempt reported again by reconciliation counts once, at its latest status, next to Paper, and that the trading operations get latency rows.
- `lib/execution/live.integration.test.ts` runs stubbed Live deploys and asserts their `leg_result`, `impact_checked`, and `basket_deployed` props (kind, mode, brokerage, source) and what the drawer reports: one success per leg after an accept-then-fill, a refused attempt and its retry as two orders, and `getOrderImpact`, `placeForceOrder`, and `getUserAccountRecentOrders` in the latency table.
- `components/telemetry/format.test.ts`: rate and number formatting.
