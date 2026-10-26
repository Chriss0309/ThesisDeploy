import type { AuthConfig } from "@/lib/auth/config";
import { decrypt, encrypt } from "@/lib/auth/crypto";
import { getProviderMetadata } from "@/lib/auth/discovery";
import { OAuthError, refreshTokens, type TokenResponse } from "@/lib/auth/oauth-client";
import { getDb } from "@/lib/db/client";
import { Prisma } from "@/lib/generated/prisma/client";

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

// The token-endpoint call (10s timeout) runs while the row lock is held, and
// other requests for the same user queue on that lock; Prisma's defaults
// (2s to start, 5s to finish) would abort healthy refreshes.
const REFRESH_TRANSACTION = { maxWait: 10_000, timeout: 20_000 };

export class ReauthRequiredError extends Error {
  name = "ReauthRequiredError";
}

type Kind = "access_token" | "refresh_token";
const context = (userId: string, kind: Kind) => `oauth_grants.${kind}:${userId}`;

function sealTokens(config: Pick<AuthConfig, "tokenKey">, userId: string, tokens: TokenResponse) {
  return {
    accessTokenEnc: encrypt(config.tokenKey, tokens.access_token, context(userId, "access_token")),
    refreshTokenEnc: encrypt(config.tokenKey, tokens.refresh_token, context(userId, "refresh_token")),
    accessExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
  };
}

const isFresh = (expiresAt: Date) => expiresAt.getTime() - Date.now() > REFRESH_MARGIN_MS;

export async function saveGrant(
  config: Pick<AuthConfig, "tokenKey" | "scopes">,
  userId: string,
  tokens: TokenResponse,
): Promise<void> {
  const data = {
    scope: tokens.scope ?? config.scopes.join(" "),
    ...sealTokens(config, userId, tokens),
  };
  await getDb().oauthGrant.upsert({
    where: { userId },
    create: { userId, ...data },
    update: data,
  });
}

export async function getGrantSummary(
  userId: string,
): Promise<{ scopes: string[]; accessExpiresAt: Date } | null> {
  const grant = await getDb().oauthGrant.findUnique({
    where: { userId },
    select: { scope: true, accessExpiresAt: true },
  });
  return grant
    ? { scopes: grant.scope.split(/\s+/).filter(Boolean), accessExpiresAt: grant.accessExpiresAt }
    : null;
}

type LockedGrant = {
  accessTokenEnc: string;
  refreshTokenEnc: string;
  accessExpiresAt: Date;
  scope: string;
};

/**
 * Returns a usable access token, refreshing it when it is within 5 minutes of
 * expiry. Pass `staleAccessToken` after the API answered 401 with that token to
 * force one refresh. SnapTrade rotates refresh tokens, so refreshes are
 * serialized per user with a row lock and re-checked once the lock is held.
 */
export async function getAccessToken(
  config: AuthConfig,
  userId: string,
  options: { staleAccessToken?: string } = {},
): Promise<string> {
  const db = getDb();
  const grant = await db.oauthGrant.findUnique({ where: { userId } });
  if (!grant) throw new ReauthRequiredError("No SnapTrade grant for user");
  if (!options.staleAccessToken && isFresh(grant.accessExpiresAt)) {
    return decrypt(config.tokenKey, grant.accessTokenEnc, context(userId, "access_token"));
  }

  const metadata = await getProviderMetadata(config);
  const result = await db.$transaction(async (tx) => {
    const [locked] = await tx.$queryRaw<LockedGrant[]>`
      select access_token_enc as "accessTokenEnc",
             refresh_token_enc as "refreshTokenEnc",
             access_expires_at as "accessExpiresAt",
             scope
      from oauth_grants
      where user_id = ${userId}::uuid
      for update
    `;
    if (!locked) return { reauth: true as const };

    const current = decrypt(config.tokenKey, locked.accessTokenEnc, context(userId, "access_token"));
    if (isFresh(locked.accessExpiresAt) && current !== options.staleAccessToken) {
      return { token: current };
    }

    let tokens: TokenResponse;
    try {
      tokens = await refreshTokens(
        config,
        metadata,
        decrypt(config.tokenKey, locked.refreshTokenEnc, context(userId, "refresh_token")),
      );
    } catch (error) {
      if (error instanceof OAuthError && error.code === "invalid_grant") {
        await tx.oauthGrant.delete({ where: { userId } });
        return { reauth: true as const };
      }
      throw error;
    }

    await tx.oauthGrant.update({
      where: { userId },
      data: { scope: tokens.scope ?? locked.scope, ...sealTokens(config, userId, tokens) },
    });
    return { token: tokens.access_token };
  }, REFRESH_TRANSACTION);

  if ("reauth" in result) throw new ReauthRequiredError("SnapTrade grant is no longer valid");
  return result.token;
}

// Deletes the stored grant and returns its refresh token so the caller can revoke it.
export async function deleteGrant(
  config: Pick<AuthConfig, "tokenKey">,
  userId: string,
): Promise<string | null> {
  try {
    const { refreshTokenEnc } = await getDb().oauthGrant.delete({
      where: { userId },
      select: { refreshTokenEnc: true },
    });
    return decrypt(config.tokenKey, refreshTokenEnc, context(userId, "refresh_token"));
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      return null;
    }
    throw error;
  }
}
