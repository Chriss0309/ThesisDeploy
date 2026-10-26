import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { getAuthConfig, type AuthConfig } from "@/lib/auth/config";
import { decrypt } from "@/lib/auth/crypto";
import { getProviderMetadata } from "@/lib/auth/discovery";
import { completeLogin, signOut, startLogin, type CallbackParams } from "@/lib/auth/flow";
import { OAuthError, refreshTokens } from "@/lib/auth/oauth-client";
import { findSessionUser } from "@/lib/auth/sessions";
import { ReauthRequiredError, getAccessToken, getGrantSummary } from "@/lib/auth/vault";
import { closeDb, getDb } from "@/lib/db/client";
import { STUB_USER, startOAuthStub } from "@/scripts/oauth-stub.mjs";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const CLIENT_ID = "test-client";
const CLIENT_SECRET = "test-secret";
const REDIRECT_URI = "http://127.0.0.1:3000/api/auth/callback";

describe.skipIf(!TEST_DATABASE_URL)("SnapTrade sign-in against a stub provider and Postgres", () => {
  let stub: Awaited<ReturnType<typeof startOAuthStub>>;
  let config: AuthConfig;

  beforeAll(async () => {
    stub = await startOAuthStub({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: REDIRECT_URI,
      // Slow enough that concurrent refreshes overlap unless the row lock serializes them.
      refreshDelayMs: 300,
    });
    vi.stubEnv("DATABASE_URL", TEST_DATABASE_URL);
    vi.stubEnv("SNAPTRADE_ISSUER", stub.issuer);
    vi.stubEnv("SNAPTRADE_OAUTH_CLIENT_ID", CLIENT_ID);
    vi.stubEnv("SNAPTRADE_OAUTH_CLIENT_SECRET", CLIENT_SECRET);
    vi.stubEnv("SNAPTRADE_OAUTH_REDIRECT_URI", REDIRECT_URI);
    vi.stubEnv("SESSION_SECRET", randomBytes(32).toString("base64"));
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
    config = getAuthConfig();
  });

  afterAll(async () => {
    await stub?.close();
    await closeDb();
    vi.unstubAllEnvs();
  });

  beforeEach(async () => {
    await getDb().$executeRaw`truncate app_users, sessions, oauth_login_attempts, oauth_grants, events, api_calls restart identity cascade`;
  });

  // Follows the provider's redirect like a browser would, without calling our callback.
  async function authorize(authorizationUrl: string): Promise<CallbackParams> {
    const response = await fetch(authorizationUrl, { redirect: "manual" });
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe(REDIRECT_URI);
    const get = (name: string) => location.searchParams.get(name);
    return { code: get("code"), state: get("state"), error: get("error"), iss: get("iss") };
  }

  async function signIn(returnTo = "/after") {
    const { authorizationUrl, state } = await startLogin(config, returnTo);
    const params = await authorize(authorizationUrl);
    const result = await completeLogin(config, params, state);
    if (!result.ok) throw new Error(`sign-in failed: ${result.error}`);
    const user = await findSessionUser(config, result.session.token);
    if (!user) throw new Error("session not found");
    return { state, params, result, user };
  }

  const expireAccessToken = (userId: string) =>
    getDb().oauthGrant.update({
      where: { userId },
      data: { accessExpiresAt: new Date(Date.now() + 60_000) },
    });

  it("builds a PKCE S256 authorization request with state, nonce, and the configured scopes", async () => {
    const { authorizationUrl, state } = await startLogin(config, "/");
    const url = new URL(authorizationUrl);
    expect(url.origin + url.pathname).toBe(`${stub.issuer}/oauth/authorize`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: "openid email profile read trade",
      state,
      code_challenge_method: "S256",
    });
    expect(url.searchParams.get("nonce")).toMatch(/^[\w-]{43}$/);
    expect(url.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/);

    const attempt = await getDb().oauthLoginAttempt.findFirstOrThrow();
    expect(attempt.state).toBe(state);
    expect(attempt.codeVerifierEnc).toMatch(/^v1\./);
  });

  it("signs in: verifies the id_token, stores encrypted tokens, and creates a hashed session", async () => {
    const { result, user } = await signIn();
    expect(result.returnTo).toBe("/after");
    expect(user).toMatchObject({
      snaptradeUserId: STUB_USER.sub,
      email: STUB_USER.email,
      emailVerified: true,
      name: STUB_USER.name,
    });

    const grant = await getDb().oauthGrant.findFirstOrThrow();
    expect(grant.scope).toBe("openid email profile read trade");
    expect(grant.accessTokenEnc).toMatch(/^v1\./);
    expect(grant.refreshTokenEnc).toMatch(/^v1\./);
    expect(grant.accessExpiresAt.getTime()).toBeGreaterThan(Date.now() + 9 * 3600_000);

    const session = await getDb().session.findFirstOrThrow();
    expect(session.id).toMatch(/^[0-9a-f]{64}$/);
    expect(session.id).not.toContain(result.session.token);

    const names = (await getDb().event.findMany({ orderBy: { id: "asc" } })).map((event) => event.name);
    expect(names).toEqual(["oauth_started", "oauth_connected"]);
  });

  it("rejects a replayed callback", async () => {
    const { state, params } = await signIn();
    await expect(completeLogin(config, params, state)).resolves.toEqual({
      ok: false,
      error: "state_mismatch",
    });
  });

  it("rejects an attacker's callback opened in a victim's browser (login CSRF)", async () => {
    const attacker = await startLogin(config, "/");
    const attackerParams = await authorize(attacker.authorizationUrl);
    const victim = await startLogin(config, "/");
    await expect(completeLogin(config, attackerParams, victim.state)).resolves.toEqual({
      ok: false,
      error: "state_mismatch",
    });
  });

  it("rejects an expired login attempt", async () => {
    const { authorizationUrl, state } = await startLogin(config, "/");
    const params = await authorize(authorizationUrl);
    await getDb().oauthLoginAttempt.updateMany({
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(completeLogin(config, params, state)).resolves.toEqual({
      ok: false,
      error: "state_mismatch",
    });
  });

  it("handles a denied consent without exchanging a code", async () => {
    stub.denyNextAuthorization();
    const tokenCalls = stub.stats.token;
    const { authorizationUrl, state } = await startLogin(config, "/");
    const params = await authorize(authorizationUrl);
    expect(params.error).toBe("access_denied");
    await expect(completeLogin(config, params, state)).resolves.toEqual({
      ok: false,
      error: "access_denied",
    });
    expect(stub.stats.token).toBe(tokenCalls);
    const names = (await getDb().event.findMany({ orderBy: { id: "asc" } })).map((event) => event.name);
    expect(names).toContain("oauth_denied");
  });

  it("rejects a callback whose iss parameter names another issuer", async () => {
    const { authorizationUrl, state } = await startLogin(config, "/");
    const params = await authorize(authorizationUrl);
    await expect(
      completeLogin(config, { ...params, iss: "https://evil.example" }, state),
    ).resolves.toEqual({ ok: false, error: "signin_failed" });
  });

  it("returns the stored access token while it is fresh, without refreshing", async () => {
    const { user } = await signIn();
    const refreshes = stub.stats.refresh;
    const first = await getAccessToken(config, user.id);
    expect(await getAccessToken(config, user.id)).toBe(first);
    expect(stub.stats.refresh).toBe(refreshes);
  });

  it("refreshes exactly once when concurrent requests find the token about to expire", async () => {
    const { user } = await signIn();
    const before = await getDb().oauthGrant.findFirstOrThrow();
    await expireAccessToken(user.id);
    const refreshes = stub.stats.refresh;

    const tokens = await Promise.all(
      Array.from({ length: 8 }, () => getAccessToken(config, user.id)),
    );

    expect(new Set(tokens).size).toBe(1);
    expect(stub.stats.refresh - refreshes).toBe(1);
    const after = await getDb().oauthGrant.findFirstOrThrow();
    expect(after.accessExpiresAt.getTime()).toBeGreaterThan(Date.now() + 9 * 3600_000);
    const refreshContext = `oauth_grants.refresh_token:${user.id}`;
    expect(decrypt(config.tokenKey, after.refreshTokenEnc, refreshContext)).not.toBe(
      decrypt(config.tokenKey, before.refreshTokenEnc, refreshContext),
    );
  });

  it("forces one refresh after a 401, and not again once another request refreshed", async () => {
    const { user } = await signIn();
    const stale = await getAccessToken(config, user.id);
    const refreshes = stub.stats.refresh;

    const renewed = await getAccessToken(config, user.id, { staleAccessToken: stale });
    expect(renewed).not.toBe(stale);
    expect(await getAccessToken(config, user.id, { staleAccessToken: stale })).toBe(renewed);
    expect(stub.stats.refresh - refreshes).toBe(1);
  });

  it("deletes the grant and requires re-authorization when the refresh token is rejected", async () => {
    const { user } = await signIn();
    await expireAccessToken(user.id);
    stub.revokeAllRefreshTokens();

    await expect(getAccessToken(config, user.id)).rejects.toBeInstanceOf(ReauthRequiredError);
    expect(await getGrantSummary(user.id)).toBeNull();
    await expect(getAccessToken(config, user.id)).rejects.toBeInstanceOf(ReauthRequiredError);
  });

  it("sign-out ends only the current session and keeps the grant", async () => {
    const first = await signIn();
    const second = await signIn();
    await expect(signOut(config, first.result.session.token, { disconnect: false })).resolves.toEqual({
      revoked: true,
    });
    expect(await findSessionUser(config, first.result.session.token)).toBeNull();
    expect(await findSessionUser(config, second.result.session.token)).not.toBeNull();
    expect(await getGrantSummary(second.user.id)).not.toBeNull();
  });

  it("disconnect revokes at SnapTrade, deletes tokens, and ends every session", async () => {
    const first = await signIn();
    const second = await signIn();
    const grant = await getDb().oauthGrant.findFirstOrThrow();
    const refreshToken = decrypt(
      config.tokenKey,
      grant.refreshTokenEnc,
      `oauth_grants.refresh_token:${second.user.id}`,
    );
    const revokes = stub.stats.revoke;

    await expect(signOut(config, first.result.session.token, { disconnect: true })).resolves.toEqual({
      revoked: true,
    });

    expect(stub.stats.revoke - revokes).toBe(1);
    expect(await getGrantSummary(first.user.id)).toBeNull();
    expect(await findSessionUser(config, second.result.session.token)).toBeNull();
    const metadata = await getProviderMetadata(config);
    const rejected = refreshTokens(config, metadata, refreshToken);
    await expect(rejected).rejects.toBeInstanceOf(OAuthError);
    await expect(rejected).rejects.toMatchObject({ status: 400, code: "invalid_grant" });
  });
});
