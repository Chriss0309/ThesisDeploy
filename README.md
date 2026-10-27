# ThesisDeploy

Turn an investment thesis into a portfolio-aware, whole-share stock basket, execute it through [SnapTrade](https://docs.snaptrade.com) (live or paper), and track drift for user-confirmed rebalancing.

Production: https://thesisdeploy.vercel.app · Health: [`/api/health`](https://thesisdeploy.vercel.app/api/health)

## Status

Early scaffold. What works today:

- Landing page with thesis presets. It pings `/api/health` on load and shows whether the backend is ready.
- `GET /api/health`: liveness, environment validation, and a database check. It returns `200` when every check passes and `503` when one fails. It reports which features are configured (booleans only), the names of malformed variables, and whether the database is reachable, migrated, and has RLS on every app table. It never returns values.
- Supabase schema for users, sessions, OAuth login attempts, OAuth grants, events, and API-call telemetry.
- Portfolio X-Ray (`/portfolio`): accounts with capability badges, cash and buying power per currency, positions, and concentration, served through a Bearer-only SnapTrade client that stays inside the per-account rate limit. A guest demo on fictional data is at `/demo`. See [`docs/portfolio-xray.md`](docs/portfolio-xray.md).
- Thesis Studio (`/studio`): Claude proposes a basket from a one-line conviction and the user's holdings across every account. SnapTrade grounds and prices every ticker in one quotes call, the top-up rule trims what the user already holds, and a whole-share solver sizes it. The Basket Composer has overlap badges, weight sliders, share steppers, and remove, with live cost and leftover cash. The guest demo is at `/demo/studio`, with cached presets and strict generation limits. See [`docs/thesis-studio.md`](docs/thesis-studio.md).
- Design system: every color, font, type size, radius, shadow, and motion value lives in `app/tokens.css`, and a test fails the build on hardcoded values anywhere else. The landing page has a three.js engraved-coin animation of paced, whole-share execution. See [`docs/design-system.md`](docs/design-system.md).

Paced execution (paper and live) and drift tracking land in later PRs.

## Stack

- Next.js 16 (App Router, Cache Components) on Vercel (Pro), Node runtime only
- TypeScript, Tailwind CSS 4, shadcn/ui (Base UI), three.js (landing illustration only, lazy-loaded)
- Zod for environment validation, Vitest for unit tests, ESLint
- Supabase Postgres via Prisma ORM 7 and the `pg` driver adapter (server-only; no Supabase Auth or supabase-js)
- SnapTrade OAuth + OIDC and the SnapTrade TypeScript SDK (Bearer-only)
- Anthropic TypeScript SDK with structured outputs

## Local development

Requires Node 22.

```bash
npm install
cp .env.example .env.local   # set DATABASE_URL for a passing health check
npm run dev                  # http://127.0.0.1:3000
```

Use `127.0.0.1` rather than `localhost`: the SnapTrade OAuth redirect URI registered for local development is `http://127.0.0.1:3000/api/auth/callback`, and it must match exactly.

| Script | What it does |
|---|---|
| `npm run dev` | Dev server |
| `npm run build` / `npm start` | Production build and server |
| `npm run lint` | ESLint |
| `npm run typecheck` | Generate Next route types, then `tsc --noEmit` |
| `npm test` | Vitest unit tests, including applying every migration to an in-memory Postgres (PGlite) |
| `npm run db:generate` | Regenerate the Prisma Client into `lib/generated/prisma` (also runs on install and build) |
| `npm run db:migrate:dev -- --create-only --name <name>` | Create a migration from `prisma/schema.prisma` against a dev database |
| `npm run db:migrate` | Apply pending migrations (`prisma migrate deploy`) to `DIRECT_URL` |
| `npm run db:drift` | Fail if `prisma/schema.prisma` has changes with no migration |
| `npm run dev:oauth-stub`, `dev:api-stub`, `dev:anthropic-stub` | Local stand-ins for SnapTrade sign-in, the SnapTrade API, and the Anthropic Messages API |

CI (GitHub Actions) runs lint, typecheck, and tests. It then applies the migrations to a fresh Postgres, runs the drift check, and builds, on every PR.

## Configuration

All variables are optional at build time so Preview deployments build without secrets; each feature checks its own variables before use. See [`.env.example`](.env.example) for the full list.

| Variable | Purpose |
|---|---|
| `APP_BASE_URL` | Canonical URL, e.g. `https://thesisdeploy.vercel.app` |
| `DATABASE_URL` | Supabase **transaction pooler** connection string (port 6543), used at runtime. `?pgbouncer=true` is unnecessary with the `pg` adapter, but harmless. |
| `DIRECT_URL` | Supabase **session pooler** or direct connection string, used only by Prisma CLI commands |
| `SHADOW_DATABASE_URL` | Empty scratch database, used only by `db:migrate:dev` and `db:drift` |
| `SNAPTRADE_OAUTH_CLIENT_ID`, `SNAPTRADE_OAUTH_CLIENT_SECRET` | SnapTrade OAuth app credentials (Dashboard → OAuth Apps). Not the Commercial API keys. |
| `SNAPTRADE_OAUTH_REDIRECT_URI` | Must exactly match a registered redirect URI |
| `SNAPTRADE_OAUTH_SCOPES` | Default `openid email profile read trade` |
| `SNAPTRADE_ISSUER` | Default `https://api.snaptrade.com` |
| `SNAPTRADE_API_BASE_URL` | Default `https://api.snaptrade.com`; point at `npm run dev:api-stub` for local testing |
| `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY` | 32 random bytes, base64 (`openssl rand -base64 32`) |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Model default `claude-sonnet-5-5`. Without a key, Thesis Studio generation is off and the demo shows sample baskets. |
| `GUEST_GENERATIONS_PER_DAY` | Claude calls the guest demo may make per rolling 24 hours across all visitors; default 40, `0` turns them off |
| `LIVE_TRADING_ENABLED` | Kill switch for real orders; default `false` |

Secrets live only in Vercel environment variables and `.env.local`, never in the repo. All SnapTrade calls go through the backend.

## Database

The schema lives in [`prisma/schema.prisma`](prisma/schema.prisma) and migrations in [`prisma/migrations/`](prisma/migrations). Prisma tracks applied migrations in `public._prisma_migrations`. The app imports the client from `lib/db/client.ts`, which uses the generated client in `lib/generated/prisma` (gitignored).

This project uses Prisma ORM 7, the stable line. Prisma 8 is still a release candidate.

```bash
# after editing prisma/schema.prisma, against a local or dev database
DIRECT_URL='postgresql://…' SHADOW_DATABASE_URL='postgresql://…' \
  npm run db:migrate:dev -- --create-only --name short_description
# review the SQL, add ENABLE ROW LEVEL SECURITY for any new table, then apply
DIRECT_URL='postgresql://…' npm run db:migrate
```

Use `npm run db:migrate` as the only way to apply migrations to Supabase. If you apply them another way (Supabase SQL editor, MCP, or `supabase db push`), Prisma won't record them and will try to re-run them later.

Every table in `public` has row-level security enabled with no policies, including `_prisma_migrations`. Prisma's schema language can't express RLS, so the migrations enable it by hand. The app connects as the table owner over the pooler and is unaffected; Supabase's `anon` and `authenticated` API roles can read and write nothing. `/api/health` returns `503` if any app table is missing or has RLS turned off.

The schema expects OAuth tokens and PKCE verifiers to be written encrypted (`*_enc` columns, AES-256-GCM with `TOKEN_ENCRYPTION_KEY`) and sessions to be keyed by a SHA-256 hash of the cookie token, never the raw token.

## Deployment

Vercel deploys `main` to production and every PR to a Preview URL. Preview URLs cannot complete SnapTrade OAuth because only the production and loopback callbacks are registered.

The project is on Vercel Pro: functions default to a 300s maximum duration and can be raised to 800s. The app still keeps request handlers short and never trades unattended; rebalances are always user-confirmed.

## SnapTrade feedback

[`docs/snaptrade-feedback.md`](docs/snaptrade-feedback.md) is a running log of API and DX friction found while building.
