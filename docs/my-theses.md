# My Theses

`/theses` (and `/demo/theses` for guests) lists every basket the user has run, valued live against what they paid. It shows how far each holding has drifted from its target weight, flags baskets that need a rebalance, and lets the user rebalance or close a basket through the same pre-flight and paced queue as the first deploy. A Paper basket is rebalanced and closed with Paper, a Live basket only Live ([Live execution](live-execution.md)); in Paper no SnapTrade order endpoint is called anywhere.

## Dashboard

One card per basket, open baskets first, closed ones under a "Closed" heading.

- **Value now.** Holdings at current marks plus basket cash, against the basket's cost basis. Unrealized gain is holdings minus cost basis. The basket's cash is the money from sells that rebalances haven't spent, plus rounding leftovers.
- **Cost basis.** The ledger's average cost for what's still held. Buys add to it at the fill price. Sells remove shares at the average cost and book the difference as realized gain (`basket_constituents.realized_total`).
- **Drift from target.** One dual-bar row per constituent: current weight as the fill, the target as an ink tick, and the gap shaded by direction. The signed number (`+10.9 pts`) comes from `computeDrift` in `lib/drift.ts`. Past ±5 points (`DEFAULT_DRIFT_THRESHOLD`) the number turns warning and the card gets a "Rebalance recommended" badge.
- **Closed baskets** show what was put in, the cash returned, and the realized gain, with no drift.

Marks come from one SnapTrade quotes call per account (batched at 10 symbols, inside the per-account budget), cached on the basket for 60 seconds. If a refresh fails, the card shows the last marks and says when they were taken. Guests get the fixture quotes from `lib/thesis/demo-quotes.json`.

## Rebalance and Close

`POST /api/baskets/:id/preflight` with `{ "kind": "rebalance" | "close" }` builds the exact order list from the ledger and fresh marks (`lib/theses/action-preflight.ts`) and saves it on the basket with a `preflightId`.

- **Rebalance** uses `planRebalance`: whole shares only, sells first. Overweight names sell down to target at the bid, and the estimated proceeds fund the buys, which go to the underweight names at the ask through the whole-share solver. Total value stays about the same, and the small remainder stays as basket cash. The modal shows what the trades raise and spend, plus "Largest drift X pts → about Y pts after these trades". Offered on every basket, with "Rebalance anyway" below the threshold.
- **Close** uses `planClose`: sell every whole share the basket holds. While the market is open the price is the bid, otherwise the last trade. When the last leg fills, the basket becomes `closed` and the proceeds are held as cash.

Confirming posts to `POST /api/executions` with `kind` and `preflightId`. That reuses the paper queue unchanged (one leg per 1.1 seconds, retry failed leg, resume after a closed tab), with these rules:

- The basket's mode decides: a Paper basket runs Paper, a Live basket runs Live (`409 mode_mismatch` otherwise). Live adds the brokerage preview, acknowledgement, and order-status reconciliation, and sells no more than the broker holds.
- A basket whose last Live run still has orders open or unconfirmed at the broker can't be rebalanced or closed until they settle (`409 orders_open`).
- Prices are valid for 5 minutes. An older pre-flight, or one replaced by a newer one, returns `409 preflight_stale`. A pre-flight that already started a run returns `409 preflight_used`.
- One active execution per account still applies. Rebalance and Close fill at the leg's pre-flight price, and each fill updates units, average cost, realized gain, and basket cash in the same transaction as the ledger entry.
- If a leg is rejected, the basket keeps whatever did fill, and "Retry failed leg" works as before.

## Guest demo

`/demo/theses` lists the guest's baskets (the `td_guest` cookie). Fixture prices never move on their own, so the page has a reviewer tool, "Simulate a market move", which scales one ticker's price by +50%, +100%, or −40% (`POST /api/baskets/:id/simulate`), and "Reset prices". It only changes the demo price multipliers stored on the basket. Rebalance and Close then work as above. Guest rebalances count toward the existing daily paper-run limits.

## Loading states

All waits use the shared loader (`docs/design-system.md` section 11); this page adds no three.js. `loading.tsx` for `/theses` and `/demo/theses` shows the `scan` loader under the page header, and the pages' own Suspense fallback is the same component, so nothing moves on the handoff. The pre-flight dialog's pricing step is the `stacks` loop (`execution-loader.tsx`), and the paced run uses the shared stepper. After a rebalance, close, or simulated move, the Rebalance, Close and Apply buttons show a `LoaderGlyph` until the refreshed valuation arrives. Links into the basket record, My Theses, and the nav show `LinkPendingStatus` toasts.

## Telemetry

| Event | When | Properties |
| --- | --- | --- |
| `drift_viewed` | The dashboard renders a basket (deferred with `after()`) | baskets valued, how many are flagged, largest drift in points, guest |
| `rebalance_confirmed` | A rebalance run starts | basket and execution IDs, mode, sells, buys, drift before and after in points, sell proceeds, buy cost |
| `basket_closed` | A close run finishes with nothing left held | basket and execution IDs, mode, orders, filled, failed, currency |

Guest events carry the demo cookie's hash in `events.guest_key`, and `leg_result` records the execution `kind`, so the [telemetry drawer](telemetry.md) counts rebalance and close legs in order success and shows a guest's My Theses activity under "You".

## Data

Migration `20261027061500_my_theses` adds columns only (no new table, so no RLS change): `baskets.contributed`, `cash`, `action_preflight`, `marks`, `marked_at`, `simulated_moves`, `closed_at`; `basket_constituents.realized_total`; and a unique `executions.preflight_id`. It backfills `contributed` from the existing cost total. No new environment variables.

## Not built

- Rebalance by threshold alerts or schedule; the user starts every run.
- Fees, taxes, and dividends in the valuation.
