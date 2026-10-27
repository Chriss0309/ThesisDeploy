# Live execution

Live sends real whole-share market orders to the user's brokerage through SnapTrade. It's available for the first deploy of a basket and for My Theses' Rebalance and Close. It reuses the Paper queue: the same pre-flight, a pace of 1.1 seconds per account, partial-failure handling, and "Retry failed leg". Only the submitter differs, plus three Live-only steps:

- a brokerage preview;
- an explicit acknowledgement;
- order-status reconciliation.

Paper is unchanged. A basket is Paper or Live for life, so the two ledgers never mix.

Everything here is tested against the local SnapTrade stub (`scripts/snaptrade-api-stub.mjs`); no test or local run calls SnapTrade's real order or impact endpoints. See the manual test at the end for the one real run on Alpaca Paper.

## Gating (`lib/execution/live-gate.ts`)

Every pre-flight computes each reason Live is unavailable. The dialog lists them under the mode switch, and confirming re-checks them on the server.

| Gate | Source | Cost |
|---|---|---|
| Kill switch | `LIVE_TRADING_ENABLED=true`. It's always off on Vercel previews (`VERCEL_ENV=preview`), whatever the variable says. | none |
| Signed in | Guest demo accounts are fictional | none |
| Trading connection | The account's capability from Portfolio X-Ray: the grant has the `trade` scope, the connection is `type: "trade"` and not disabled, and the brokerage `allows_trading` | non-limited `listBrokerageAuthorizations` and `listAllUserAccounts` |
| Market hours | NYSE or TSX regular session, from the holiday calendar in `lib/market-hours.ts`. Re-checked at confirm. | none |
| Buying power | Deploy: buys ≤ buying power (cash on non-margin accounts) in the basket currency. Rebalance: buys ≤ buying power + sell proceeds, with a warning when the buys rely on unsettled sale proceeds. Close: not needed. | 1 balance call (deploy); balance and positions (rebalance and close) |
| Holdings | Rebalance and close sell at most what the broker holds (`min(ledger, actual)`): a close sells the shares actually held, and a rebalance that would oversell is blocked | included above |
| Ledger mode | A Paper basket can't be rebalanced or closed Live, and a Live basket can't be rebalanced or closed with Paper | none |
| Brokerage preview | A broker that refuses to preview a leg blocks Live with its reason | see below |

The account calls happen only when nothing cheaper already blocks Live. A Live pre-flight costs 2 account-limited calls for a deploy (quotes and balance) and 3 for a rebalance or close (quotes, balance, and positions). Each call goes through the shared per-account budget (8 of SnapTrade's 10 per minute).

## Brokerage preview (`POST /api/baskets/:id/impact`)

Choosing Live runs SnapTrade's `getOrderImpact` for each leg. Impact isn't account-limited, so each call reserves the same 1.1-second per-account pacing slot as orders. Nothing is placed. The result is saved on the pre-flight and labeled the way SnapTrade's [order impact guide](https://docs.snaptrade.com/docs/order-impact-and-confirmation) recommends:

- **Brokerage preview**: estimated commissions, foreign-exchange fees, and the broker's estimate of cash after the orders.
- **Not available**: the broker has no preview. Detected by HTTP 404, 405, or 501, or a "not supported" message; SnapTrade doesn't document the shape. Live stays available, the "Order impact unavailable" disclaimer is shown, and unknown fees are never shown as $0.00.
- **Brokerage preview for X of N orders**: a leg failed with a 5xx or network error.
- A leg the broker **rejects** (another 4xx) blocks Live with the broker's message.

The order values themselves are labeled "Application-generated estimate". Confirming Live requires that a preview was attempted (`409 impact_required`).

## Confirming (`POST /api/executions` with `mode: "live"`)

On top of Paper's rules (Idempotency-Key, a pre-flight from the last 5 minutes, one active execution per account), Live requires:

- the basket's signed-in owner (`403 live_signed_in_only`);
- the kill switch (`403 live_disabled`);
- `acknowledgeLive: true`: the user ticked "I understand these are real market orders" (`400 acknowledgement_required`);
- a pre-flight whose Live gate passed (`409 live_unavailable`);
- a preview attempt (`409 impact_required`);
- an open market now (`409 market_closed`).

The confirmation snapshot stores the acknowledgement time, the impact result, and any Live warnings. Event: `execution_confirmed` with `mode: "live"`, `paperAccount`, and `impactSource`.

## Placing orders (`lib/execution/live-orders.ts`)

The drain loop is unchanged; the Live submitter calls `placeForceOrder` for each claimed leg:

```
{ account_id, action: BUY|SELL, symbol, order_type: "Market", time_in_force: "Day", units, client_order_id }
```

- **Ticker, not universal symbol ID.** Orders use `symbol`, which SnapTrade recommends for placing orders; universal symbol IDs aren't stable.
- **Idempotency.** `client_order_id` is a UUID per attempt, stored on the leg. A retry is a new attempt with a new ID. SnapTrade forwards it, and duplicate handling is up to the broker.
- **Kill switch.** It's read on every leg: turning it off stops the rest of a run without sending anything.
- **Not account-limited.** Trade calls are recorded in `api_calls` without an account hash, so they don't spend the data-call budget.

| SnapTrade answer | Leg |
|---|---|
| `EXECUTED` with a price | `executed`; the fill reaches the ledger |
| `ACCEPTED`, `PENDING`, `QUEUED`, … | `accepted` (open at the broker) |
| `PARTIAL` | `partial`: the filled shares reach the ledger, and the rest is still open |
| `PARTIAL_CANCELED`, or `CANCELED`/`EXPIRED` after a fill | `executed` for the shares filled, with a note |
| `REJECTED`, `FAILED`, or an unfilled `CANCELED`/`EXPIRED`; HTTP 4xx | `rejected` with the broker's reason; "Retry failed leg" |
| HTTP 429 | back to `pending` after `Retry-After`; SnapTrade didn't take the order |
| HTTP 5xx, timeout, network error | `unknown`: may have reached the broker; never resent automatically |
| 401 twice, or the kill switch off | `failed`; nothing was sent |

After every leg is sent, a run with orders still open is `working` (a new execution status). It frees the account for other baskets, but My Theses won't rebalance or close the basket until its orders settle (`409 orders_open`).

## Reconciliation (`POST /api/executions/:id/reconcile`)

While a Live run has `accepted`, `partial`, or `unknown` legs, the browser asks for a status check: first after 3 seconds, then every 15 seconds, for about 5 minutes. The user can also click "Check status now". Each check:

1. **Throttle.** It takes the execution's slot: `executions.reconciled_at` is updated only if the last check was at least 15 seconds ago, shared across tabs and instances. Otherwise it returns `nextCheckAt` without calling SnapTrade.
2. **Fetch.** It makes one `getUserAccountRecentOrders(only_executed=false)` call, which is account-limited. If the broker doesn't support recent orders (HTTP 404, 405, or 501), it falls back to `getUserAccountOrderDetail` for up to 3 open legs.
3. **Match.**
   - An open leg is matched by `brokerage_order_id`.
   - An `unknown` leg is matched by symbol, side, quantity, and `time_placed` after the leg was claimed.
   - Fills reach the ledger as deltas against what the leg already recorded, so a fill is applied once even when it arrives in pieces.
4. **Settle.** It re-derives the run's status and settles the basket. A deploy activates on its first fill, and a close closes when everything is sold. Each changed leg emits `leg_result` with `source: "reconcile"`.

An `unknown` leg that isn't found stays `unknown` with "Not in Alpaca Paper's orders from the last 24 hours as of 11:42 AM ET…". After at least one check, the user can tick "I checked Alpaca Paper: this order isn't there" and send it again. That marks the old attempt `failed` (`not_placed_confirmed`) and queues a new attempt with a new `client_order_id`.

## UI

- **Pre-flight.**
  - Paper and Live are a segmented control. Live baskets open on Live, with Paper disabled and the reason shown.
  - Selecting Live shows an inverse ink banner ("Live · Real market orders · Sends N whole-share market orders to … at …, a paper-trading account"), then runs the preview with the `scan` loader.
  - Below that: the impact summary and its source label, warnings, SnapTrade's estimate disclaimer, the acknowledgement checkbox, and the brand-colored "Submit N live orders" button.
- **Run.**
  - The header badge reads "Live" or "Live · paper account". Legs show Submitted (with the broker order ID), Partly filled, Filled (with the fill price), Rejected (with the broker's reason), or Unconfirmed.
  - A status bar shows when the broker was last checked, with a "Check status now" button.
  - An interrupted Live run never resumes on its own; the user clicks "Resume execution".
- **Basket and My Theses.** Live baskets carry the Live badge. Their record says fills are what the broker reported. A Live deploy with unsettled orders shows its run on the My Theses card.

## Data

- **Migration.** `20261027071708_live_execution` adds `executions.reconciled_at`, a column on an existing table, so no RLS change. No other schema change.
- **Leg columns.** Existing columns hold the Live details: `client_order_id`, `brokerage_order_id`, `snaptrade_status`, `filled_units`, `fill_price`, `request_id`, and `latency_ms`.
- **New event.** `impact_checked`, with the brokerage, number of legs, source, rejections, and latency.

## Tests

- **`lib/execution/live.integration.test.ts`** runs against Postgres, the OAuth stub, and the SnapTrade stub. It covers:
  - a Live deploy: a gated pre-flight (one balance call), the brokerage preview of every leg, and acknowledgement and preview requirements;
  - paced `placeForceOrder` calls with each leg's `client_order_id`, ending `working`, then reconciled to `completed` with the ledger filled and `basket_deployed`;
  - a second check within 15 seconds that makes no SnapTrade call;
  - a refused leg (`rejected`, with the broker's message), and a leg placed but unanswered (`unknown`) found by reconciliation;
  - a retry with a new `client_order_id`;
  - an unknown leg that is never resent until a check missed it and the user confirms;
  - a 429 re-sent after its wait;
  - the kill switch stopping a run mid-way;
  - an unsupported preview (Live stays available) and a refused preview (Live blocked);
  - every gate, with no account calls once blocked;
  - Live rebalance and close of a Live basket against the broker's holdings (Paper refused);
  - guests refused.
- **`lib/execution/live-orders.test.ts`** covers order-status mapping and unknown-order matching.
- **Gate unit tests** are in `preflight.test.ts` and `theses.test.ts`.

## Manual test on Alpaca Paper (Christopher)

**Before you start:**

- **OAuth app.** The SnapTrade OAuth app must allow the `trade` scope.
- **Alpaca Paper connection.** In your SnapTrade Personal workspace, the Alpaca Paper connection must be a **trade** connection (not read-only).
- **Market hours.** Run during the regular session: a weekday, 9:30 AM–4:00 PM ET, not an NYSE holiday.

1. **Migrate.** `DIRECT_URL=… npm run db:migrate` applies `20261027071708_live_execution` (one column).
2. **Configure Production on Vercel** (not Preview: Live stays off there regardless). Don't set `SNAPTRADE_ISSUER` or `SNAPTRADE_API_BASE_URL`; the defaults are the real SnapTrade.

   | Variable | Value |
   |---|---|
   | `LIVE_TRADING_ENABLED` | `true` |
   | `SNAPTRADE_OAUTH_CLIENT_ID`, `SNAPTRADE_OAUTH_CLIENT_SECRET` | The Test OAuth app |
   | `SNAPTRADE_OAUTH_REDIRECT_URI` | `https://thesisdeploy.vercel.app/api/auth/callback` |
   | `SNAPTRADE_OAUTH_SCOPES` | Unset, or exactly `openid email profile read trade` |
   | `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY`, `DATABASE_URL`, `ANTHROPIC_API_KEY` | As before |

   Redeploy. `/api/health` should show `"liveTrading": true`.
3. **Re-authorize.** If you signed in before the `trade` scope was granted, choose **Sign out and disconnect**, then sign in again; a token refresh doesn't add scopes. On **Portfolio X-Ray**, the Alpaca Paper account should show **Trading**.
4. **Pre-flight.** In **Thesis Studio**, pick the Alpaca Paper account, USD, and a small budget (about $500). Generate a preset, remove all but 2–3 lines, and click **Continue to pre-flight**.
   - The price line should say SnapTrade quotes.
   - **Live brokerage** should be selectable. If it isn't, the reasons under the switch say why.
5. **Preview.** Select **Live brokerage**.
   - The banner should say "…to Paper Trading at Alpaca Paper, a paper-trading account".
   - "Asking Alpaca Paper to preview N orders…" runs for about 1 second per leg.
   - Note which **Impact source** you get ("Brokerage preview" or "Not available") for `docs/snaptrade-feedback.md`.
6. **Submit.** Tick the acknowledgement and click **Submit N live orders**.
   - Legs go out about 1 second apart and show **Submitted** with an Alpaca order ID.
   - Within about 15 seconds, the status check turns them **Filled** with Alpaca's fill price, and the run reads **Completed**.
   - Check the Alpaca Paper dashboard: the same symbols, quantities, and market/day orders.
7. **Saved basket.** Click **View saved basket**. The badge reads **Live · paper account**, and the ledger shows the filled shares and costs.
8. **My Theses.** Open **My Theses** and run **Close** on that basket.
   - Live is preselected, and Paper is disabled with "This basket holds real shares…".
   - Preview, acknowledge, and submit: the sells fill, and the basket moves to **Closed**.
   - Alpaca's positions return to what they were.
9. **Kill switch.** Set `LIVE_TRADING_ENABLED=false` and redeploy. A new pre-flight should list "Live trading is switched off on this deployment." Then open a Preview deployment: it should say "always off on preview deployments".
10. **Data.**
    - Leg outcomes, with Alpaca's order IDs and the same `client_order_id`s:
      ```sql
      select seq, attempt, status, snaptrade_status, brokerage_order_id, client_order_id, filled_units, fill_price
      from execution_legs
      where execution_id = (select id from executions where mode = 'live' order by created_at desc limit 1);
      ```
    - The SnapTrade calls behind the run:
      ```sql
      select operation, http_status, request_id from api_calls
      where operation in ('getOrderImpact', 'placeForceOrder', 'getUserAccountRecentOrders')
      order by id desc limit 20;
      ```
    - The funnel:
      ```sql
      select name, props from events
      where name in ('impact_checked', 'execution_confirmed', 'leg_result', 'basket_deployed', 'basket_closed')
      order by id desc limit 15;
      ```
