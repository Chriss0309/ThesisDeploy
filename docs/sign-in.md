# Sign in with SnapTrade

ThesisDeploy has one login: SnapTrade's OAuth 2.0 + OpenID Connect flow from a confidential client, as described in [Build an OAuth App](https://docs.snaptrade.com/docs/oauth-apps). The same authorization signs the user in and grants `read` and `trade` access to the brokerage connections they manage in SnapTrade Personal.

## Flow

1. **`GET /api/auth/login`** reads the provider metadata from `${SNAPTRADE_ISSUER}/.well-known/openid-configuration` (cached for an hour, and validated: issuer match, `S256`, `RS256`, every requested scope supported). It creates a fresh `state`, `nonce`, and PKCE `code_verifier`, stores them in `oauth_login_attempts` (verifier encrypted, 10-minute TTL), and sets an httpOnly `td_oauth_state` cookie that binds the attempt to this browser. It then redirects to the authorization endpoint. If the request arrived on a different origin than the registered redirect URI (for example `localhost` instead of `127.0.0.1`, or a Vercel preview), it first redirects to the same route on the callback's origin so the cookie lands where the callback can read it.
2. **`GET /api/auth/callback`** rejects the callback unless its `state` equals the cookie (login-CSRF protection). It then consumes the attempt with `DELETE … RETURNING`, so a replayed or expired callback fails. An `error` (such as `access_denied`) ends the flow without a token exchange. A callback `iss` that names a different issuer is rejected (RFC 9207). The code is exchanged with HTTP Basic client authentication and the `code_verifier`. The `id_token` is verified against the provider's JWKS: RS256 only, `iss`, `aud` (plus `azp` when there are several audiences), `exp`, `iat` no older than 10 minutes, and `nonce`. Only `sub` and `nonce` are required; malformed optional claims are dropped, never trusted.
3. The user is upserted on the `sub` claim, the tokens are stored encrypted in `oauth_grants`, and a session is created. The browser receives an httpOnly, `SameSite=Lax` `td_session` cookie (`Secure` when the redirect URI is HTTPS) that is valid for 7 days.
4. **`POST /api/auth/logout`** ends the current session. With `?disconnect=1` it also deletes the stored grant, revokes the refresh token at SnapTrade's revocation endpoint, and ends every session for the user. Cross-origin POSTs are rejected.
5. **`GET /api/me`** returns the signed-in user and the granted scopes, or `401`.

## Storage

| Data | Where | Protection |
|---|---|---|
| Access and refresh tokens | `oauth_grants` | AES-256-GCM with `TOKEN_ENCRYPTION_KEY`; the user ID and column are bound as associated data, so a ciphertext copied to another row or column will not decrypt |
| PKCE verifier | `oauth_login_attempts` | Same encryption; the row is single-use and expires after 10 minutes |
| Session | `sessions` | Only HMAC-SHA256(`SESSION_SECRET`, cookie token) is stored, so write access to the table alone cannot mint a session |
| `id_token` | Not stored | Verified, claims copied, then discarded |

Codes, tokens, and the client secret are never logged. Errors are logged by name and code only.

## Token refresh

`getAccessToken(config, userId)` in `lib/auth/vault.ts` returns the stored access token while more than 5 minutes remain before it expires. Otherwise it refreshes inside a Prisma interactive transaction that locks the grant row (`SELECT … FOR UPDATE` via `$queryRaw`) and re-checks expiry once it holds the lock. Concurrent requests therefore spend SnapTrade's rotating refresh token exactly once. After an API `401`, callers pass `{ staleAccessToken }` to force one refresh; if another request already refreshed, the new token is returned without a second refresh. An `invalid_grant` deletes the grant and raises `ReauthRequiredError`, and the UI then offers "Reconnect SnapTrade".

## Testing locally without a SnapTrade OAuth app

`scripts/oauth-stub.mjs` is a local stand-in for SnapTrade's discovery, authorize, token, revocation, and JWKS endpoints. It enforces PKCE S256, HTTP Basic client auth, exact redirect URIs, single-use codes, and rotating refresh tokens, and it signs RS256 `id_tokens` for a fake user. Deployed environments never use it.

```bash
npm run dev:oauth-stub            # http://127.0.0.1:4010
# .env.local
SNAPTRADE_ISSUER=http://127.0.0.1:4010
SNAPTRADE_OAUTH_CLIENT_ID=stub-client
SNAPTRADE_OAUTH_CLIENT_SECRET=stub-secret
SNAPTRADE_OAUTH_REDIRECT_URI=http://127.0.0.1:3000/api/auth/callback
SESSION_SECRET=<openssl rand -base64 32>
TOKEN_ENCRYPTION_KEY=<openssl rand -base64 32>
DATABASE_URL=<a migrated Postgres database>
```

Open `http://127.0.0.1:3000` and click **Sign in with SnapTrade**. The stub approves immediately. `curl -X POST http://127.0.0.1:4010/__stub/deny-next` makes the next authorization a denial.

The integration tests in `lib/auth/flow.integration.test.ts` drive the same flow against the stub and a real Postgres. They run when `TEST_DATABASE_URL` points at a migrated database, which CI provides; locally:

```bash
TEST_DATABASE_URL=postgresql://… npm test
```

## Manual test against SnapTrade

Prerequisites:

- The Test OAuth app is registered in the SnapTrade Dashboard with both redirect URIs, which must match exactly: `https://thesisdeploy.vercel.app/api/auth/callback` and `http://127.0.0.1:3000/api/auth/callback`.
- Migrations have been applied to the target database.
- The tester has a SnapTrade Personal account with at least one connection (for trading, a trade-type connection such as Alpaca Paper). Test apps allow at most 5 users.

1. **Configure.** Locally, put the real `SNAPTRADE_OAUTH_CLIENT_ID` and `SNAPTRADE_OAUTH_CLIENT_SECRET`, `SNAPTRADE_OAUTH_REDIRECT_URI=http://127.0.0.1:3000/api/auth/callback`, `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY`, and `DATABASE_URL` in `.env.local`, leaving `SNAPTRADE_ISSUER` unset. Run `npm run build && npm start -- -H 127.0.0.1`. (On production, the same variables are set in Vercel with the HTTPS redirect URI.)
2. **Health.** `GET /api/health` shows `"snaptradeOAuth": true` and `"database": {"status": "ok"}`.
3. **Consent.** Open `http://127.0.0.1:3000` and click **Sign in with SnapTrade**. On SnapTrade's consent screen, check that it lists sign-in, email, profile, read, and trade. Approve.
4. **Signed in.** You land on `/` with "Signed in as …" and "Read and trade access granted". `GET /api/me` shows `canTrade: true` and an `accessExpiresAt` about 10 hours ahead.
5. **Storage.** In the database, `select scope, left(access_token_enc, 3) from oauth_grants` shows the granted scopes and a `v1.` ciphertext. `select id from sessions` shows a 64-character hex value that differs from the `td_session` cookie.
6. **Sign out.** Click **Sign out**, then sign in again.
7. **Deny.** Click **Sign in with SnapTrade** and deny on the consent screen. The page shows "You declined access in SnapTrade".
8. **Disconnect.** While signed in, click **Disconnect SnapTrade**. The page shows "SnapTrade is disconnected" (not the "didn't confirm the revocation" warning), the `oauth_grants` row is gone, and signing in again asks for consent again. If the SnapTrade Dashboard lists authorized apps, ThesisDeploy should no longer appear there.
9. **Production.** After merging, repeat steps 2–8 on `https://thesisdeploy.vercel.app`.

Token refresh is first exercised against the real API once PR 4 starts calling SnapTrade. Until then it is covered by the integration tests.
