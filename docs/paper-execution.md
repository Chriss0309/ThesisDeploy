# Paper execution

"Continue to pre-flight" in the Basket Composer opens a pre-flight modal with the exact order list. Confirming it runs the orders through a paced queue, one leg per second per account, and saves the result as a Virtual Basket. Paper mode works at any time: weekends, read-only connections, and $0 cash. Paper never sends an order. Live, behind `LIVE_TRADING_ENABLED`, uses the same queue with a SnapTrade submitter; see [Live execution](live-execution.md).

`/demo/studio` runs the same flow for guests on the fictional demo portfolio, and their baskets open at `/demo/baskets/:id`. Signed-in baskets open at `/baskets/:id`.

## Pre-flight (`POST /api/preflight`, `POST /api/demo/preflight`)

1. **Lines.** The composer sends its current lines: symbol, target weight, and whole shares. Signed in, every symbol must be a resolved candidate of the user's own thesis, and the account and currency must match it. Company names and universal symbol IDs come from the thesis, not the browser. Guest lines must be in the demo price feed in the basket currency.
2. **Account.** Signed in, the account list is re-read from SnapTrade. These calls aren't account-limited.
3. **Prices.** One `getUserAccountQuotes` call for every symbol with shares. It is account-limited, so it is checked against the shared per-account budget first, and a 429 tells the user how long to wait. Guests get the fixture quotes. Buys are priced at the ask while the market is open, otherwise at the last trade. Lines with 0 shares or no price are listed as "Not ordered" with the reason.
4. **Order list.** `BUY {units} {symbol} @ MKT`, numbered, with the price, its basis (ask or last trade), and the estimated cost, plus the total, the budget, and what stays in cash. Share counts are exactly what the user confirmed: pre-flight re-prices them but doesn't re-solve them.
5. **Live gating.** Paper is always available. Live lists every reason it's unavailable:
   - the kill switch is off (always, on Vercel previews);
   - the account can't trade, with the X-Ray capability reason;
   - the market is closed (the NYSE/TSX calendar from `lib/market-hours.ts`);
   - buying power in the basket currency is short or unknown (one fresh balance call, made only when nothing else blocks Live);
   - the demo account is fictional.

   The full gate, the brokerage preview, and Live confirmation are in [Live execution](live-execution.md).
6. **Disclosures.** The modal says where prices come from ("App estimate from SnapTrade quotes … no brokerage order preview"), that paper fills are simulated at the pre-flight price, and, for Live, that fees aren't available rather than showing them as $0.00.
7. **Draft basket.** The pre-flight is saved as a `draft` basket with its constituents (target weights renormalized over the ordered names, planned shares, and an empty ledger). Event: `preflight_opened`.

Quotes are valid for 5 minutes. Confirming an older pre-flight returns `409 preflight_stale`, and the modal re-runs pre-flight in place, updating the same draft.

## Confirming (`POST /api/executions`)

Body `{ basketId, mode, simulateRejectSeq }`, plus an `Idempotency-Key` header. The key is a UUID that the modal generates once per pre-flight.

- **Same key:** returns the existing execution (`200`, not `201`). A double click or a retried request can't create a second run.
- **One deploy per basket:** a second confirmation with a new key returns `409 already_executed`.
- **One active execution per account:** `executions.active_account_key` equals `account_key` while the execution is queued or running and is NULL otherwise. Its unique index allows one active execution per account (NULLs never collide). A second one gets `409 execution_active` with the active execution's ID. This also covers guests: demo accounts are shared fixtures, so their account key is derived per guest.
- **Live:** `403 live_disabled` while the kill switch is off; otherwise Live's own rules apply (acknowledgement, passed gate, brokerage preview, open market). See [Live execution](live-execution.md).
- **Records:** the execution stores the confirmation snapshot (order list, quotes, market status, disclosures shown). Each order becomes a leg (`seq`, `attempt` 1, `client_order_id`, estimated price). Event: `execution_confirmed`.

## The paced queue (`POST /api/executions/:id/drain`)

Vercel functions can't run in the background, so the browser drives the queue. The drain route streams NDJSON progress and loops:

1. **Recover stale claims.** A leg left in `claimed` for more than 2 minutes means the invocation that claimed it died (the route's `maxDuration` is 60s). A paper leg never reached a broker, so it goes back to `pending`. A live leg may have, so it becomes `unknown` and is never resubmitted automatically.
2. **Reserve a pacing slot** in `account_pacing`. The `INSERT … ON CONFLICT DO UPDATE … WHERE last_submit_at <= clock_timestamp() - 1.1s` succeeds only if this account's last submission was at least 1.1 seconds ago, across every execution, tab, and serverless instance. Otherwise the route streams a `pacing` event and sleeps for the remainder.
3. **Claim the next pending leg** in order with `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED)`. Concurrent drains never claim the same leg.
4. **Submit** through the mode's submitter. The kill switch is checked on every leg. **Paper** fills the whole leg at its pre-flight price and records `brokerage_order_id = paper_<uuid>` and status `EXECUTED`.
5. **Record the result** in one transaction: the leg is written only if it's still `claimed`, and a fill also increments the basket ledger (`ledger_units`, `cost_total`). A fill can't be applied twice. Event: `leg_result`.

The loop stops when no leg is pending, after a 45-second budget, or when the client disconnects. The request's abort signal stops it from claiming another leg, so nothing runs unattended. The final `done` event carries the execution. While legs are still pending, the browser POSTs `drain` again; a dropped stream is recovered the same way. Re-POSTing is always safe, because only pending legs can be claimed. A closed tab resumes the next time the basket page is opened.

**Finalizing** locks the execution row. If nothing is pending or claimed, it sets `completed`, `partial` (some legs failed), or `failed` (none filled), and clears `active_account_key`. The basket becomes `active` on its first fill, which emits `basket_deployed` once. A basket with no fills goes back to `draft`.

**Leg states:** `pending → claimed → executed | rejected | failed`, `claimed → pending` (a 429 sets `not_before`, or a stale paper claim), `claimed → unknown` (a stale live claim), and `pending → skipped` (cancel).

**Timing:** six legs take about 6–7 seconds, well inside one invocation.

## Partial failures and retry

A rejected leg doesn't stop the queue: the reason is recorded on the leg and the remaining legs are submitted. The stepper shows the rejection with a **Retry failed leg** button. `POST /api/executions/:id/legs/:legId/retry`:

- Only the latest attempt of a `rejected` or `failed` leg can be retried, up to 3 attempts.
- The retry is a new leg row with the same `seq`, the next `attempt`, and a new `client_order_id`. The rejected attempt stays as history.
- The execution goes back to `running`, which is subject to the one-active-per-account rule.
- The retry fills at the original pre-flight price, so a paper ledger never mixes quotes from two different moments.

`POST /api/executions/:id/cancel` skips the remaining pending legs. Filled legs stay in the basket. Event: `execution_canceled`.

**Failure injection.** The pre-flight modal has a Paper-only reviewer toggle, "Simulate a broker rejection on leg N". It rejects the first attempt of that leg the way a broker would, so the retry fills.

## Virtual Basket record

| Table | What it holds |
|---|---|
| `baskets` | Owner (user, or guest cookie hash), thesis, account, `mode` (paper or live, never mixed), `status` (draft, deploying, active, closed), budget, currency, and the latest pre-flight |
| `basket_constituents` | Symbol, universal symbol ID, target weight, planned shares, and the ledger: filled shares and cost, changed only together with a filled leg |
| `executions` | Kind (`deploy`; rebalance and close come with My Theses), mode, status, idempotency key, confirmation snapshot, failure injection, and timestamps |
| `execution_legs` | One row per attempt: seq, attempt, action, symbol, units, estimated price, `client_order_id`, status, broker order ID, fill, error, and claim and submit times |
| `account_pacing` | Last submission per account key |

Every table has row-level security enabled with no policies, like the rest of the schema.

## Guest demo

- **Ownership:** guest baskets belong to an httpOnly `td_guest` cookie (random, 30 days, `SameSite=Lax`). It's issued by the first demo thesis or pre-flight request, and only its keyed hash is stored. The same execution routes serve signed-in users and guests, and ownership is checked on every request: another visitor, or a signed-in user, gets a 404.
- **Limits:** per visitor (keyed IP hash, like the thesis demo), per rolling 24 hours, 60 pre-flights and 20 paper runs. Across all guests, 1,000 paper runs. Guest pre-flight never calls SnapTrade.

## Telemetry

| Event | Props |
|---|---|
| `preflight_opened` | basket, thesis, orders, lines left out, currency, market open, Live available, guest |
| `execution_confirmed` | execution, basket, mode, kind, orders, market open, failure injection on, guest |
| `leg_result` | execution, leg, kind, mode, action, status, attempt, brokerage slug (`demo` for guests), error code, latency, `source` (`submit`, or `reconcile` for Live status checks), guest |
| `basket_deployed` | basket, execution, kind, mode, orders, filled, failed, currency, guest (once per basket) |
| `execution_canceled` | execution, mode, legs skipped, guest |

## SnapTrade calls

| Step | Call | Counts against the account's 10/minute limit |
|---|---|---|
| Pre-flight (signed in) | `listBrokerageAuthorizations`, `listAllUserAccounts` | No |
| Pre-flight (signed in) | `getUserAccountQuotes`, one batch | 1 |
| Drain, retry, cancel (Paper) | none | 0 |

## Configuration

No new environment variables. `LIVE_TRADING_ENABLED` (default `false`) remains the kill switch. Apply the migration that adds the five tables before deploying: `DIRECT_URL=… npm run db:migrate`. `/api/health` reports them as missing until then. Without a database, pre-flight answers `503` with a clear message.

## Tests

- `lib/execution/preflight.test.ts`: order list, price basis, the reasons Live is unavailable, and disclosures.
- `lib/execution/summary.test.ts`: leg bookkeeping, status derivation, retry rules, the paper submitter, and NDJSON parsing.
- `lib/execution/service.integration.test.ts`: runs against Postgres and the SnapTrade and OAuth stubs. It covers:
  - one quotes call per pre-flight;
  - Idempotency-Key replay;
  - real 1.1-second spacing between legs;
  - a rejected leg that doesn't stop the queue, then its retry;
  - a ledger written from fills only;
  - one active execution per account, and cancel;
  - resuming after the time budget;
  - two concurrent drains that never fill a leg twice;
  - stopping when the client disconnects;
  - recovering a stale claim;
  - refusing Live and stale pre-flights;
  - guest ownership and limits;
  - no request to any trade or order path.

## Manual test

1. **Guest, partial failure.** In a private window, open `/demo/studio`, pick **Paper Trading (USD)**, generate **AI power & nuclear**, then click **Continue to pre-flight**.
   - The modal lists `BUY n SYMBOL @ MKT` for each line with shares.
   - Live is disabled with its reasons (demo account, kill switch, and market closed outside 9:30–16:00 ET).
   - Tick **Simulate a broker rejection on leg 2**, then **Run paper simulation**.
   - Legs land about a second apart. Leg 2 shows **Rejected** with the reason, and the queue finishes the rest: "n−1 of n legs filled · 1 failed".
2. **Retry.** Click **Retry failed leg**. Attempt 2 fills, the summary reads "n of n legs filled", and attempt 1 stays as a note.
3. **Saved basket.** Click **View saved basket**. The ledger shows filled shares, average fill, and cost per name, with the execution log below. Open the same URL in another browser: it's a 404.
4. **Resume.** Run another pre-flight and close the tab right after confirming. Reopen `/demo/baskets/:id` (the URL is shown in the modal's link): the remaining legs resume and fill.
5. **Signed in.** Sign in, generate on the Alpaca Paper account, and run pre-flight. The price line should say "App estimate from SnapTrade quotes". Confirm a paper run and check `/baskets/:id`.
6. **Data.** Check the database:
   - `select status, count(*) from execution_legs group by 1` shows the leg outcomes;
   - `select name, props from events where name in ('preflight_opened','execution_confirmed','leg_result','basket_deployed') order by id desc limit 10` shows the funnel;
   - `select operation from api_calls order by id desc limit 5` shows one `getUserAccountQuotes` per pre-flight and nothing for the run.
