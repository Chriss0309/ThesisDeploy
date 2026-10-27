# ThesisDeploy

Turn an investment thesis into a whole-share stock basket that's checked against what you already own, execute it through SnapTrade (Live or Paper), and keep it on target with rebalances you confirm.

**Live demo: https://thesisdeploy.vercel.app** · no sign-in needed for the [demo](https://thesisdeploy.vercel.app/demo/studio) · [health](https://thesisdeploy.vercel.app/api/health)

Built as a take-home for SnapTrade's Product Engineer role. API and DX feedback from the build is in [`docs/snaptrade-feedback.md`](docs/snaptrade-feedback.md).

## What it is

Going from "I think North American grid power is the next bottleneck" to owning it takes three steps that live in different places: finding the 5–8 companies that express the idea, checking them against what you already hold across accounts, then placing a handful of orders and keeping them grouped. The products that bundle these steps (Public's generated indexes, Fidelity Basket Portfolios, M1 Pies) all require moving your money to them.

ThesisDeploy does it on top of the brokerage you already use:

1. **Portfolio X-Ray** reads every connected account: cash and buying power per currency, positions, and concentration.
2. **Thesis Studio** asks Claude for candidates given your conviction *and* your holdings, then grounds every ticker against SnapTrade quotes and symbol search, trims what you already own (the "top-up" rule), and sizes whole shares within your budget. You can reweight, step shares, and remove names; cost and leftover cash update as you go.
3. **Pre-flight** shows the exact orders, fresh prices, and every reason Live isn't available. Confirming runs a queue that sends one order per account per 1.1 seconds, keeps going past a rejected leg, and offers "Retry failed leg". The result is a Virtual Basket: a ledger of what actually filled.
4. **My Theses** values each basket, shows each stock's drift from its target, flags drift past 5 points, and builds a whole-share rebalance (sells first) or a close, through the same pre-flight and queue.

Paper mode runs the identical pipeline without sending orders, so everything works on weekends, read-only connections, and $0 cash.

### Why it's built on a SnapTrade OAuth app

One authorization is both the sign-in (OpenID Connect) and the brokerage access (`read` and `trade` scopes). Users manage their brokerage connections in SnapTrade, so ThesisDeploy never sees brokerage credentials, every broker SnapTrade supports works on day one, and disconnecting revokes access at SnapTrade. The client secret, tokens, and every SnapTrade call stay on the server.

## A 2-minute reviewer path

1. **Demo, no sign-in.** Open [`/demo/studio`](https://thesisdeploy.vercel.app/demo/studio), pick **AI power & nuclear**, and click **Generate basket**. Presets are cached; the first run for an account and currency calls Claude (10–40 seconds). Note the overlap badges: the demo TFSA already holds some of these names.
2. **Pre-flight with a failure.** Click **Continue to pre-flight**. Live is listed as unavailable, with every reason (demo account, kill switch, market hours). Tick **Simulate a broker rejection on leg 2**, then **Run paper simulation**. Leg 2 is rejected and the queue carries on; click **Retry failed leg**.
3. **Lifecycle.** Click **View saved basket**, then **My Theses** in the demo banner. Use **Simulate a market move** (+50%) to push a stock past 5 points of drift, then **Rebalance** and **Close basket**.
4. **Telemetry.** Open **► Product telemetry** in the footer. "You" shows your own demo run: funnel, edit rate, symbol hit rate, order success.
5. **With SnapTrade.** Click **Sign in with SnapTrade** to use your own accounts (X-Ray, Studio, Paper, My Theses). The OAuth app is a Test app, so at most 5 people can sign in. Live orders need a `trade` connection and the market's regular session; Alpaca Paper is the safe way to try them.

## How SnapTrade is used

All calls go through one wrapper, `callSnapTrade` in [`lib/snaptrade/client.ts`](lib/snaptrade/client.ts). The TypeScript SDK has no OAuth mode, so its API classes are built without a `Configuration` and given an axios instance that sends only `Authorization: Bearer`. Every call is recorded in `api_calls` (operation, status, latency, request ID, remaining account budget, hashed account ID).

| Endpoint | Used for | Account-limited (10/min) |
|---|---|---|
| OIDC discovery, authorize, token, revocation, JWKS | Sign-in (PKCE S256), refresh with rotation, disconnect, `id_token` verification | – |
| `listBrokerageAuthorizations`, `listAllUserAccounts` | Account list, institution names, and each account's trading capability (scope, connection type, disabled, `allows_trading`) | No |
| `getUserAccountBalance`, `getAllAccountPositions` | X-Ray, overlap context, Live buying power and holdings checks | Yes, 1 each |
| `getUserAccountQuotes` (`use_ticker`, ≤10 symbols) | Grounding and pricing a basket, pre-flight, My Theses valuation | Yes, 1 per batch |
| `symbolSearchUserAccount` | Tickers the quotes call didn't return (exact ticker and currency match) | No |
| `getOrderImpact` | Live brokerage preview, one per leg, labeled by source | No (paced like orders) |
| `placeForceOrder` | Live legs: whole-share Market/Day orders by ticker, with a `client_order_id` | No (paced) |
| `getUserAccountRecentOrders` (`only_executed=false`), `getUserAccountOrderDetail` | Live order status and fills | Yes, at most 1 per 15 s per execution |

**Rate limits.** SnapTrade allows 10 requests per minute per account on account-data endpoints. The app keeps its own budget of 8 per rolling minute per account, counted in `api_calls` so every serverless instance sees the same number, and stops early when SnapTrade reports `X-RateLimit-Account-Remaining: 0`. Balances and positions are cached for 10 minutes (with a Refresh button), quotes are one batch per basket, basket valuations are cached for 60 seconds, and identical concurrent loads share one set of calls. A 429 is never retried automatically: the SDK's hidden retry loop is disabled (`validateStatus: () => true`), and the wait time comes from `Retry-After`, the exhausted layer's reset header, or SnapTrade's "available in N seconds" body. Users see "try again in about N seconds" over cached data, never an error page.

**401s.** Refresh once and retry once. The refresh runs under a row lock so SnapTrade's rotating refresh token is spent exactly once across concurrent requests. A second 401 or an `invalid_grant` deletes the grant and the page asks the user to reconnect.

**Pacing.** One order per 1.1 seconds per account, enforced by a conditional upsert on `account_pacing` in Postgres, so it holds across executions, tabs, and serverless instances. Vercel can't run background work, so the browser drives the queue: `POST /api/executions/:id/drain` streams progress for up to 45 seconds, and the browser re-posts it until no leg is pending. Re-posting is always safe, and a closed tab resumes when the basket is reopened. Nothing trades unattended.

**Idempotency.** Each confirmation carries an `Idempotency-Key` (a UUID fixed per pre-flight), so a double click returns the same execution. A basket deploys once, and a partial unique index allows one active execution per account. Each order attempt has its own `client_order_id`; a retry is a new attempt with a new ID.

**Reconciliation.** A Live leg that SnapTrade accepted but hasn't filled is checked from recent orders (matched by `brokerage_order_id`), first after 3 seconds and then every 15 seconds while the page is open. Fills are applied as deltas, so a fill reported in pieces is counted once. A placement that timed out or returned a 5xx becomes `unknown`: it may have reached the broker, so it's matched by symbol, side, quantity, and time, and it's never resent until the user confirms it isn't at the broker.

**Live safety.** Live needs the `LIVE_TRADING_ENABLED` kill switch (always off on Vercel previews), a signed-in owner, a trading connection, the regular NYSE/TSX session (own holiday calendar through 2027), enough buying power, holdings that cover any sells, a brokerage preview attempt, and an explicit "these are real market orders" acknowledgement. The server re-checks the gate, the market, and the 5-minute price validity at confirm, and reads the kill switch again before every leg.

Details: [sign-in](docs/sign-in.md), [X-Ray and the client](docs/portfolio-xray.md), [Thesis Studio](docs/thesis-studio.md), [Paper execution](docs/paper-execution.md), [My Theses](docs/my-theses.md), [Live execution](docs/live-execution.md).

## Architecture

```
Browser (React, same-origin fetch only; CSP connect-src 'self')
   │  httpOnly session cookie
   ▼
Next.js 16 route handlers and server components on Vercel (Node runtime)
   ├─ lib/auth        SnapTrade OAuth + OIDC, PKCE, sessions, encrypted token vault
   ├─ lib/snaptrade   Bearer-only SDK client, per-account budget, api_calls
   ├─ lib/thesis      Claude structured output → validation → grounding → overlap → solver
   ├─ lib/execution   pre-flight, Live gate, paced Postgres queue, Paper/Live submitters, reconciliation
   ├─ lib/theses      valuation, drift, rebalance and close plans
   └─ lib/telemetry   events and aggregates for the drawer
   ▼                         ▼                      ▼
Supabase Postgres       api.snaptrade.com      api.anthropic.com
(Prisma 7, pg adapter)  (OAuth + API)          (Claude Sonnet 5.5)
```

- **Pure libraries** (`lib/solver.ts`, `lib/overlap.ts`, `lib/drift.ts`, `lib/market-hours.ts`) run in the browser for instant recompute in the composer and again on the server at pre-flight.
- **Thesis generation** uses Claude structured outputs, then re-checks everything the schema can't enforce (counts, bounds, duplicate tickers, weights) in code. The thesis text is passed as data inside tags. Grounding drops anything SnapTrade can't price in the basket's currency, and ETFs.
- **Next.js 16** with Cache Components: static shells are prerendered and SnapTrade data streams in; pages that call SnapTrade are never prefetched.

### Data model

Every table has row-level security enabled with no policies, so Supabase's `anon` and `authenticated` roles can read nothing; the app connects as the owner over the pooler. `/api/health` returns 503 if any table is missing or has RLS off.

| Table | Holds |
|---|---|
| `app_users`, `sessions`, `oauth_login_attempts`, `oauth_grants` | Users keyed on SnapTrade's `sub`; sessions stored as an HMAC of the cookie; single-use login attempts; tokens encrypted with AES-256-GCM |
| `account_snapshots` | 10-minute cache of balances and positions per account |
| `theses`, `thesis_candidates` | Raw model output, prompt, latency, tokens; every proposed ticker with its resolution status, price, overlap, and final weight |
| `baskets`, `basket_constituents` | The Virtual Basket: mode (Paper or Live, never mixed), status, target weights, and a ledger changed only by fills |
| `executions`, `execution_legs`, `account_pacing` | Confirmation snapshots, idempotency keys, one row per order attempt, last submission per account |
| `events`, `api_calls` | Product funnel events and every SnapTrade call |

Schema: [`prisma/schema.prisma`](prisma/schema.prisma). Migrations: [`prisma/migrations/`](prisma/migrations), applied only with `npm run db:migrate`.

### Security

- **Secrets stay on the server.** The browser talks only to ThesisDeploy; the Content-Security-Policy's `connect-src 'self'` enforces that no page can call SnapTrade or Anthropic directly.
- **OAuth.** PKCE S256; `state` bound to an httpOnly cookie (login CSRF); a single-use, encrypted login attempt; `nonce`; `id_token` verified with RS256 against JWKS (`iss`, `aud`, `azp`, `exp`, `iat`); a mismatched callback `iss` rejected (RFC 9207). Disconnect revokes the refresh token at SnapTrade.
- **Storage.** Tokens and PKCE verifiers are encrypted with AES-256-GCM, with the user and column bound as associated data. Sessions store only HMAC-SHA256 of the cookie token.
- **Cookies and CSRF.** `httpOnly`, `SameSite=Lax`, `Secure` on HTTPS. Every mutating route rejects a foreign `Origin`; JSON routes also require `application/json`, which a cross-site form can't send without a CORS preflight that's never granted.
- **Headers.** CSP (`frame-ancestors 'none'`, `object-src 'none'`, `form-action 'self'`), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, COOP, and HSTS ([`next.config.ts`](next.config.ts)).
- **Input.** Every route validates its body with Zod. The server never trusts the browser's prices, symbols, or company names: pre-flight re-reads the thesis, the account, and quotes from its own sources.
- **Privacy.** Account IDs reach telemetry only as keyed hashes; guests are keyed by a hash of their demo cookie and, for rate limits, an HMAC of their IP. Tokens, codes, and account numbers are never logged.
- **Abuse limits.** The guest demo caps Claude calls (40 per day across all visitors, 3 custom prompts per visitor), pre-flights, and paper runs; signed-in users get 30 generations a day.

## Design system and three.js

Inspired by Spade's annotated, engraved look rather than copied: warm paper and ink, one cobalt accent that never means "gain", Bricolage Grotesque for display, Instrument Sans for UI, IBM Plex Mono for data. Every color, font, size, radius, shadow, and duration lives in [`app/tokens.css`](app/tokens.css), and a test in CI fails on any hardcoded value or arbitrary Tailwind class anywhere else.

The landing hero is an original three.js scene: an engraved coin with a bull emblem, and order legs landing as whole-share stacks one per second. The same engraving language drives every loader and page mark (coin, linked rings, scan, orbit, stacks), all drawn by one shared renderer so a page uses a single WebGL context. three.js loads lazily after hydration, views pause offscreen, and phones get a lower frame and pixel budget; there the hero plays its story once and holds. Reduced motion does not stop these scenes. Spec: [`docs/design-system.md`](docs/design-system.md); every motif is on [`/design/loaders`](https://thesisdeploy.vercel.app/design/loaders).

## Telemetry

**► Product telemetry** in every footer opens a drawer built from first-party events and `api_calls`, for everyone and for "you" (your sign-in or demo cookie), over 30 days:

- **Activation funnel:** connected → generated → deployed, then drift viewed, rebalanced, closed. Tells whether people drop at generation or at pre-flight.
- **Basket edit rate:** suggested tickers removed or resized before pre-flight. A proxy for whether people trust the basket as suggested, and what to change in the prompt or the overlap rule.
- **Symbol resolution hit rate:** tickers Claude proposed that SnapTrade could price, with drop reasons.
- **Order success by brokerage,** and **SnapTrade latency** (p50/p95 per operation) with **429 count:** where broker quirks and rate limits bite.

Aggregates only. Details: [`docs/telemetry.md`](docs/telemetry.md).

## Quality

- **Tests.** 282 Vitest tests: the solver, overlap, drift, rebalance, and market-hours libraries; ticker normalization and grounding; the Live gate and order-status mapping; and integration tests against real Postgres and local stand-ins for SnapTrade's OAuth and API and for Anthropic (sign-in, refresh races, rate limits, the paced queue, concurrent drains, retries, reconciliation, unknown orders, telemetry math). One test applies every migration to an in-memory Postgres.
- **CI** (GitHub Actions) runs lint, typecheck, migrations plus a schema drift check on a fresh Postgres, the tests, and a production build on every PR.
- **End-to-end smoke test.** `npm run smoke` walks the whole reviewer journey above in Chrome, guest and signed in, including a rejected leg and its retry, a 401 refresh, the rate-limit notice, and a revoked grant. It fails on any console error, CSP violation, or 5xx.
- **Accessibility.** axe reports no violations on any page or dialog at desktop and 390 px widths. Dialogs trap focus and return it to the control that opened them; every chart has a text equivalent; badges never rely on color alone; touch targets for primary actions are 44 px.
- **Performance** (Lighthouse 12, production build, local). Desktop: 99–100 on the landing page, demo X-Ray, Studio, and My Theses, with CLS at 0. Mobile: 90 on X-Ray and 93 on My Theses; 74–91 on Studio, whose composer streams in behind a skeleton and sometimes lands after first paint on a throttled CPU; about 71 on the landing page, where the three.js hero is the remaining main-thread cost. Accessibility, best practices, and SEO score 100 on every page measured.

## Known limits and tradeoffs

- **5 sign-ins.** SnapTrade Test OAuth apps allow 5 users and a Production app needs KYC, so the full product also runs as a no-login demo on fictional data.
- **Whole-share Market/Day orders only.** No fractional, limit, bracket, or options orders: the lowest common denominator works at every broker.
- **US and TSX common stocks and ADRs, one currency per basket.** There's no FX source, so CAD and USD amounts are never converted or mixed. ETFs are excluded.
- **SnapTrade quotes only.** Quotes may be delayed and are never polled; the demo uses a fixed fictional price feed.
- **Live only in the regular session.** Off-hours behavior is brokerage-specific and undocumented, so Live is blocked outside 9:30–4:00 ET.
- **The browser drives execution.** No background workers or cron trading: closing the tab pauses a run until the basket is opened again, and order status is checked only while the page is open. A Live leg left `unknown` waits for the user.
- **Paper fills at the pre-flight price.** No slippage or partial-fill model.
- **Whole-share rebalancing can leave cash.** If an underweight name's gap is smaller than one share, the solver doesn't buy it, so a rebalance may only sell.
- **Valuation ignores fees, taxes, and dividends.**
- **No webhooks.** Order and connection updates are pulled, not pushed.
- **CSP allows inline scripts.** Cache Components serves prerendered static shells, which can't carry a per-request nonce; the policy still pins every other source to this origin.

**What I'd do next at scale:** move the queue to Vercel Queues or a worker so runs survive closed tabs; subscribe to SnapTrade webhooks for fills and broken connections instead of polling; move the rate budget from Postgres counts to Redis; and add a market-data provider so quotes stop competing with orders for the account's 10 calls a minute.

## Local setup

Requires Node 22 and Postgres (any local Postgres 15+; the Supabase CLI works too).

```bash
npm install
cp .env.example .env.local      # fill in what you need; every variable is documented there
createdb thesisdeploy && createdb thesisdeploy_shadow
DIRECT_URL=postgresql://localhost:5432/thesisdeploy npm run db:migrate
npm run dev                     # http://127.0.0.1:3000
```

Use `127.0.0.1`, not `localhost`: the registered local OAuth redirect URI is `http://127.0.0.1:3000/api/auth/callback`, and it must match exactly. Without any keys, the landing page, `/demo`, and `/demo/studio` (with committed sample baskets) work against the database alone.

### Running everything without SnapTrade or Anthropic

Three local stand-ins mirror the documented contracts: SnapTrade's OAuth and OIDC endpoints (PKCE, rotating refresh tokens, RS256 `id_token`s), SnapTrade's account, quote, and trading endpoints (with the 10-per-minute account limit and switchable order outcomes), and Anthropic's Messages API. Deployed environments never use them.

```bash
npm run dev:oauth-stub        # http://127.0.0.1:4010
npm run dev:api-stub          # http://127.0.0.1:4020
npm run dev:anthropic-stub    # http://127.0.0.1:4030
```

```bash
# .env.local
DATABASE_URL=postgresql://localhost:5432/thesisdeploy
SNAPTRADE_ISSUER=http://127.0.0.1:4010
SNAPTRADE_API_BASE_URL=http://127.0.0.1:4020
SNAPTRADE_OAUTH_CLIENT_ID=stub-client
SNAPTRADE_OAUTH_CLIENT_SECRET=stub-secret
SNAPTRADE_OAUTH_REDIRECT_URI=http://127.0.0.1:3000/api/auth/callback
SESSION_SECRET=<openssl rand -base64 32>
TOKEN_ENCRYPTION_KEY=<openssl rand -base64 32>
ANTHROPIC_API_KEY=stub
ANTHROPIC_BASE_URL=http://127.0.0.1:4030
```

### End-to-end smoke test

With the stubs and `.env.local` above, build and start the app, then run the smoke test (it uses your installed Chrome; set `CHROME_PATH` for another Chromium):

```bash
npm run build && npm start -- -H 127.0.0.1 &
npm run smoke                                            # guest + signed in + edge cases
npm run smoke -- --guest https://thesisdeploy.vercel.app # guest demo only, any deployment
```

### Scripts

| Script | What it does |
|---|---|
| `npm run dev` / `npm run build` / `npm start` | Dev server, production build, production server |
| `npm run lint`, `npm run typecheck` | ESLint; Next route types plus `tsc --noEmit` |
| `npm test` | Vitest. Integration tests run when `TEST_DATABASE_URL` points at a migrated local database (they truncate it) |
| `npm run smoke` | Browser smoke test of the reviewer journey (see above) |
| `npm run db:migrate` | Apply pending migrations to `DIRECT_URL` (`prisma migrate deploy`) |
| `npm run db:migrate:dev -- --create-only --name <name>` | Create a migration from `prisma/schema.prisma` (needs `SHADOW_DATABASE_URL`); add `ENABLE ROW LEVEL SECURITY` for new tables by hand |
| `npm run db:drift` | Fail if the schema has changes with no migration |
| `npm run dev:oauth-stub`, `dev:api-stub`, `dev:anthropic-stub` | The local stand-ins above |

## Deployment

Vercel deploys `main` to production and every PR to a preview. Previews can't complete sign-in, because only the production and loopback callbacks are registered with SnapTrade, and Live is always off there.

| Variable | Environments | Needed for |
|---|---|---|
| `DATABASE_URL` (Supabase transaction pooler, port 6543) | Production | Everything except the landing page and demo X-Ray |
| `SNAPTRADE_OAUTH_CLIENT_ID`, `SNAPTRADE_OAUTH_CLIENT_SECRET` | Production | Sign-in |
| `SNAPTRADE_OAUTH_REDIRECT_URI` = `https://thesisdeploy.vercel.app/api/auth/callback` | Production | Sign-in |
| `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY` (32 random bytes, base64) | Production | Sign-in, session and telemetry hashing |
| `ANTHROPIC_API_KEY` | Production | Live generation; without it the demo serves sample baskets |
| `LIVE_TRADING_ENABLED=true` | Production only | Live orders; previews ignore it |
| `ANTHROPIC_MODEL`, `GUEST_GENERATIONS_PER_DAY`, `SNAPTRADE_OAUTH_SCOPES`, `APP_BASE_URL` | Optional | Overrides; defaults are documented in `.env.example` |

Previews built without these variables still build and serve the static pages. `DIRECT_URL` is used only by `npm run db:migrate` from a workstation, never by the deployed app. [`.env.example`](.env.example) documents every variable.

## More documentation

| Doc | Covers |
|---|---|
| [`docs/sign-in.md`](docs/sign-in.md) | OAuth + OIDC flow, token storage, refresh, disconnect |
| [`docs/portfolio-xray.md`](docs/portfolio-xray.md) | The SnapTrade client, rate budget, snapshot cache |
| [`docs/thesis-studio.md`](docs/thesis-studio.md) | Generation, grounding, overlap, solver, guest limits |
| [`docs/paper-execution.md`](docs/paper-execution.md) | Pre-flight, the paced queue, retries, the Virtual Basket |
| [`docs/my-theses.md`](docs/my-theses.md) | Valuation, drift, rebalance, close |
| [`docs/live-execution.md`](docs/live-execution.md) | Live gating, preview, orders, reconciliation, the Alpaca Paper test |
| [`docs/telemetry.md`](docs/telemetry.md) | Metrics, events, privacy |
| [`docs/design-system.md`](docs/design-system.md) | Tokens, components, three.js motion |
| [`docs/snaptrade-feedback.md`](docs/snaptrade-feedback.md) | API and DX feedback for SnapTrade |
