import { timingSafeEqual } from "node:crypto";

import type { AuthConfig } from "@/lib/auth/config";
import { pkceChallenge, randomToken } from "@/lib/auth/crypto";
import { getProviderMetadata } from "@/lib/auth/discovery";
import { remoteJwks, verifyIdToken, type IdentityClaims } from "@/lib/auth/id-token";
import { consumeLoginAttempt, createLoginAttempt } from "@/lib/auth/login-attempts";
import { exchangeCode, revokeRefreshToken } from "@/lib/auth/oauth-client";
import { createSession, findSessionUser, revokeSession, revokeUserSessions } from "@/lib/auth/sessions";
import { deleteGrant, saveGrant } from "@/lib/auth/vault";
import { getDb } from "@/lib/db/client";
import { describeError } from "@/lib/errors";
import { recordEvent } from "@/lib/telemetry/events";

export type AuthErrorCode = "access_denied" | "state_mismatch" | "signin_failed";

export function safeReturnTo(value: string | null | undefined): string {
  if (!value || value.length > 512) return "/";
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
  return value;
}

export async function startLogin(
  config: AuthConfig,
  returnTo: string,
): Promise<{ authorizationUrl: string; state: string }> {
  const metadata = await getProviderMetadata(config);
  const state = randomToken(32);
  const nonce = randomToken(32);
  const codeVerifier = randomToken(64);
  await createLoginAttempt(config, { state, nonce, codeVerifier, returnTo: safeReturnTo(returnTo) });

  const url = new URL(metadata.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: config.scopes.join(" "),
    state,
    nonce,
    code_challenge: pkceChallenge(codeVerifier),
    code_challenge_method: "S256",
  }).toString();

  await recordEvent("oauth_started", { scopes: config.scopes });
  return { authorizationUrl: url.toString(), state };
}

export type CallbackParams = {
  code: string | null;
  state: string | null;
  error: string | null;
  iss: string | null;
};

export type LoginResult =
  | { ok: true; session: { token: string; expiresAt: Date }; returnTo: string }
  | { ok: false; error: AuthErrorCode };

function sameValue(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function upsertUser(claims: IdentityClaims): Promise<string> {
  const profile = {
    email: claims.email,
    emailVerified: claims.emailVerified,
    name: claims.name,
    lastLoginAt: new Date(),
  };
  const { id } = await getDb().appUser.upsert({
    where: { snaptradeUserId: claims.sub },
    create: { snaptradeUserId: claims.sub, ...profile },
    update: profile,
    select: { id: true },
  });
  return id;
}

/**
 * `boundState` is the state from the httpOnly cookie set when this browser
 * started the login; requiring it to match stops an attacker from completing
 * their own authorization in a victim's browser (login CSRF).
 */
export async function completeLogin(
  config: AuthConfig,
  params: CallbackParams,
  boundState: string | undefined,
): Promise<LoginResult> {
  if (!params.state || !boundState || !sameValue(params.state, boundState)) {
    return { ok: false, error: "state_mismatch" };
  }

  try {
    const attempt = await consumeLoginAttempt(config, params.state);
    if (!attempt) return { ok: false, error: "state_mismatch" };

    if (params.error) {
      const error = /^[a-z_]{1,64}$/.test(params.error) ? params.error : "unknown";
      await recordEvent("oauth_denied", { error });
      return { ok: false, error: error === "access_denied" ? "access_denied" : "signin_failed" };
    }

    const metadata = await getProviderMetadata(config);
    // Only one issuer is configured, so a missing `iss` cannot enable a mix-up
    // attack; a mismatched one is still rejected (RFC 9207).
    if (params.iss && params.iss !== metadata.issuer) throw new Error("Callback issuer mismatch");
    if (!params.code) throw new Error("Callback is missing the authorization code");

    const tokens = await exchangeCode(config, metadata, {
      code: params.code,
      codeVerifier: attempt.codeVerifier,
    });
    if (!tokens.id_token) throw new Error("Token response is missing id_token");

    const claims = await verifyIdToken(tokens.id_token, {
      jwks: remoteJwks(metadata.jwks_uri),
      issuer: metadata.issuer,
      clientId: config.clientId,
      nonce: attempt.nonce,
    });

    const userId = await upsertUser(claims);
    await saveGrant(config, userId, tokens);
    const session = await createSession(config, userId);

    const scopes = (tokens.scope ?? config.scopes.join(" ")).split(/\s+/).filter(Boolean);
    await recordEvent("oauth_connected", { scopes, trade: scopes.includes("trade") }, userId);
    return { ok: true, session, returnTo: attempt.returnTo };
  } catch (error) {
    console.error("[auth] sign-in failed", describeError(error));
    return { ok: false, error: "signin_failed" };
  }
}

/**
 * Signs out the current session. With `disconnect`, also deletes the stored
 * SnapTrade grant, revokes its refresh token at SnapTrade, and signs out every
 * session for the user. Returns false if SnapTrade revocation failed; local
 * tokens are deleted either way.
 */
export async function signOut(
  config: AuthConfig,
  sessionToken: string,
  options: { disconnect: boolean },
): Promise<{ revoked: boolean }> {
  const user = await findSessionUser(config, sessionToken);
  await revokeSession(config, sessionToken);
  if (!options.disconnect || !user) return { revoked: true };

  const refreshToken = await deleteGrant(config, user.id);
  await revokeUserSessions(user.id);
  if (!refreshToken) return { revoked: true };

  try {
    await revokeRefreshToken(config, await getProviderMetadata(config), refreshToken);
    await recordEvent("oauth_disconnected", {}, user.id);
    return { revoked: true };
  } catch (error) {
    console.error("[auth] revocation failed", describeError(error));
    await recordEvent("oauth_disconnected", { revokeFailed: true }, user.id);
    return { revoked: false };
  }
}
