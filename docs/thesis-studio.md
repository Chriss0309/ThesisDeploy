# Thesis Studio

Thesis Studio (`/studio`) turns a one-line conviction into a whole-share stock basket on the signed-in user's portfolio. `/demo/studio` runs the same pipeline on the fictional demo portfolio with no sign-in. Nothing is ordered here: "Continue to pre-flight" hands the edited basket to [paper execution](paper-execution.md).

## Pipeline (`POST /api/theses`)

1. **Portfolio context.** Balances and positions for every connected account come from the 10-minute snapshot cache (`lib/portfolio/service.ts`), so the page load and the generate request share them. `lib/thesis/prompt.ts` serializes up to 30 holdings merged by symbol across accounts (value, currency, share of that currency's holdings and cash, accounts), cash per account, the budget and its currency, the selected account, and the overlap mode. Values are never converted between currencies.
2. **Generation.** One ThesisDeploy AI call with structured outputs (`output_config.format` from `zodOutputFormat`), model `ANTHROPIC_MODEL` (default `claude-sonnet-5-5`), at most 3,000 output tokens. The schema asks for 6–8 candidates with ticker, listing (US or TSX), company, a one-sentence rationale, a percent weight, and a holding note, plus a title, summary, risk profile, `on_topic` flag, and excluded names. The thesis text sits inside `<thesis>` tags and the system prompt treats it as data. `stop_reason` is checked before parsing: `refusal`, `max_tokens`, unparseable JSON, and schema mismatches each become a clear error.
3. **Validation in code** (`lib/thesis/normalize.ts`). Structured outputs don't enforce counts, lengths, or numeric bounds, so tickers are normalized (`NYSE: BRK-B` → `BRK.B`, `CCJ.TO` → `CCJ`), duplicates and non-positive weights are dropped, the basket is capped at 8, text is clamped, and weights are renormalized to 1.
4. **Grounding** (`lib/thesis/grounding.ts`). Baskets are single-currency: a CAD budget looks up `TICKER.TO`, a USD budget the bare ticker. One `getUserAccountQuotes` call (`use_ticker=true`, at most 10 symbols) returns the universal symbol and last/bid/ask for every candidate. Misses go to `symbolSearchUserAccount`, which needs an exact ticker: a match in another currency is `currency_mismatch`, no match is `not_found`. Types other than common stock (`cs`) and ADRs (`ad`) are `untradeable`, so ETFs are dropped. SnapTrade doesn't document whether an unknown ticker is omitted or fails the batch; if the batch is rejected (400, 404, or 422), every candidate is searched and the confirmed tickers are quoted once more.
5. **Overlap** (`lib/overlap.ts`, top-up rule). Each resolved name buys only the gap between its target dollars and what the user already holds across all accounts, matched by share-class FIGI (so `CCJ` and `CCJ.TO` are one company), then weights are renormalized. Holdings in another currency are shown but not netted, because there's no FX source. Ignore mode keeps ThesisDeploy's weights and only reports the overlap.
6. **Sizing** (`lib/solver.ts`). Whole shares at the ask while the market is open, otherwise the last trade, with a 1.5% slippage reserve and a greedy remainder pass.
7. **Persistence.** `theses` keeps the raw structured output, prompt, context settings, model, latency, and token counts. `thesis_candidates` keeps every proposed ticker with its resolution status, price source, overlap value, and final weight and units; it is the source for the symbol-resolution hit rate. Events: `thesis_requested`, `thesis_generated` (model, latency, tokens), `symbols_resolved` (proposed, resolved, dropped by reason), and `basket_edited`.

## SnapTrade calls and the rate limit

| Step | Call | Counts against the account's 10/minute limit |
|---|---|---|
| Account list | `listBrokerageAuthorizations`, `listAllUserAccounts` | No |
| Holdings for context and overlap | `getUserAccountBalance` + `getAllAccountPositions` per account, only when its snapshot is over 10 minutes old | 2 per stale account, each in its own bucket |
| Prices | `getUserAccountQuotes`, one batch | 1 (2 if SnapTrade rejects the batch) |
| Misses | `symbolSearchUserAccount` | No; not on SnapTrade's list of account-limited endpoints |

Every call goes through `callSnapTrade`, so it is recorded in `api_calls` and checked against the shared per-account budget from Portfolio X-Ray. The budget is checked **before** ThesisDeploy's AI is called, so a request that can't be priced doesn't spend tokens.

## Basket Composer

Edits run in the browser with the same solver (`lib/thesis/composer-state.ts`):

- **Weight slider.** Sets one line's weight; the other lines scale proportionally to fill the rest, and every line is re-solved.
- **Share stepper.** Overrides one line's shares and re-prices the basket. `+` is disabled once the next share would cost more than the cash left under the spend cap (budget less the 1.5% slippage reserve); it stays focusable and says why, e.g. "Needs $84.30 CAD, $40.79 CAD left after the slippage reserve", so the basket can't go over budget.
- **Remove / Restore.** Removes a line, renormalizes the others, and re-solves; Restore brings it back.
- **Overlap badges.** New exposure, Overlap adjusted (with the dollars held, the share of that currency's portfolio, the accounts, and the weight before and after), Already held at target, Held in another currency, or Overlap ignored.
- The capital line reads "Deploying X of B across N whole-share orders; R stays in cash", with a bar per line. Candidates dropped by grounding and companies ThesisDeploy excluded are listed with reasons.

Signed-in edits send `basket_edited` (remove, restore, reweight, step) for the edit-rate metric; slider drags and repeated clicks are debounced into one event.

## Guest demo and abuse limits

`POST /api/demo/theses` never calls SnapTrade: holdings come from `lib/portfolio/demo-fixtures.json` and prices from `lib/thesis/demo-quotes.json` (93 fictional quotes in SnapTrade's response shape). The demo prompt lists the symbols the feed can price.

ThesisDeploy's AI is called only on a cache miss and within these limits:

- **Presets** are generated once per demo account, currency, overlap mode, and model, then served from `theses` for 7 days. That bounds preset spend to at most 48 generations a week (3 presets × 4 accounts × 2 currencies × 2 overlap modes). The budget isn't part of the cache key; the solver resizes cached weights for any budget.
- **Custom prompts** are cached for 24 hours by prompt and context, and limited to 3 per visitor per rolling 24 hours (the IP from Vercel's `x-real-ip`, stored only as an HMAC keyed with `SESSION_SECRET`).
- **All guest generations** (presets included) share a cap of `GUEST_GENERATIONS_PER_DAY` per rolling 24 hours (default 40; `0` turns guest generation off). When it's reached, presets fall back to committed sample output and custom prompts get a 429.
- Limits are counted in `events`, shared by every serverless instance. Each request inserts its row first and then counts, so concurrent requests can't overshoot; rejected requests delete their row so spam can't use up the allowance. Identical concurrent requests share one in-flight generation.
- Both routes accept only same-origin `application/json` POSTs, so another site can't spend generations from a visitor's browser.
- Without `ANTHROPIC_API_KEY` or a database, presets show the committed sample baskets in `lib/thesis/sample-outputs.json` (labeled as samples in the UI), and custom prompts are disabled.

Signed-in users are limited to 30 generations per rolling 24 hours.

## Environment variables

| Variable | Notes |
|---|---|
| `ANTHROPIC_API_KEY` | Required for live generation. Without it, signed-in generation is disabled and the demo shows sample baskets for presets only. |
| `ANTHROPIC_MODEL` | Optional; default `claude-sonnet-5-5`. Part of the guest cache key, so changing it regenerates presets. |
| `GUEST_GENERATIONS_PER_DAY` | Optional; default 40. |
| `ANTHROPIC_BASE_URL` | Local testing only: point it at `npm run dev:anthropic-stub`. |

The migration `20261027001619_thesis_studio` adds `theses` and `thesis_candidates`; `/api/health` reports them as missing until it's applied.

## Testing locally without SnapTrade or Anthropic

`scripts/anthropic-stub.mjs` answers Messages API requests with the sample basket that matches the thesis theme and budget currency (any thesis it doesn't recognize gets the AI power sample), after a 1.5-second delay. `POST /__stub/next?stop_reason=refusal` or `?status=529` makes the next response a refusal or an overload. The SnapTrade API stub now also serves `GET /accounts/{id}/quotes` (account-limited) and `POST /accounts/{id}/symbols`; `POST /__stub/unknown-quotes?mode=reject` makes an unknown ticker fail the whole quotes batch.

```bash
npm run dev:oauth-stub       # http://127.0.0.1:4010 (see docs/sign-in.md)
npm run dev:api-stub         # http://127.0.0.1:4020
npm run dev:anthropic-stub   # http://127.0.0.1:4030
# .env.local: the stub sign-in variables from docs/sign-in.md, plus
SNAPTRADE_API_BASE_URL=http://127.0.0.1:4020
ANTHROPIC_API_KEY=stub
ANTHROPIC_BASE_URL=http://127.0.0.1:4030
```

Tests: `lib/thesis/*.test.ts` cover ticker normalization, grounding (including the batch-rejection fallback), overlap and sizing on the demo portfolio, prompt serialization, the Anthropic request and its failure modes (one test goes through the real SDK against the stub), composer edits, and every committed sample. `lib/thesis/service.integration.test.ts` runs the whole pipeline against the OAuth and SnapTrade stubs and Postgres: one quotes call, `api_calls` rows, persistence, the budget check before generation, per-user and guest limits, caching, and concurrent requests. It runs when `TEST_DATABASE_URL` is set, as in CI.

## Manual test with a real SnapTrade account

1. **Deploy with a key.** Set `ANTHROPIC_API_KEY` in Vercel and apply the migration. `/api/health` should return 200 with `anthropic: true`.
2. **Guest demo.** In a private window, open `/demo/studio`, pick **AI power & nuclear**, and generate. The first run per account and currency calls ThesisDeploy's AI (10–40 seconds); generating again shows "Cached … result". On TFSA (CAD), CCJ.TO should say **Already held at target**. Switch to Paper Trading (USD): CEG, VST, GEV, and ETN are held there, so they should be trimmed or excluded. Type a custom prompt four times with different text: the fourth should be refused with the per-visitor limit.
3. **Signed in.** Sign in, open **Thesis Studio**, choose the Alpaca Paper account in USD, and generate a preset. The source line should say "SnapTrade quotes for …". Compare two prices with your brokerage, and check that any holding you own across accounts shows an overlap badge with the right account names.
4. **Edit.** Move a weight slider, step shares up until the summary goes red, remove and restore a line, then reset. Each change should update cost and leftover cash immediately.
5. **Check the data.** `select resolution_status, count(*) from thesis_candidates group by 1` gives the hit rate; `select operation, http_status, account_hash is not null as scoped from api_calls order by id desc limit 6` should show one `getUserAccountQuotes` per thesis; `select name, props from events where name in ('thesis_generated', 'symbols_resolved', 'basket_edited') order by id desc limit 5` shows latency, tokens, drops, and edits.
