import { configuredFeatures, parseServerEnv, serverEnv } from "@/lib/env";

export class AuthNotConfiguredError extends Error {
  name = "AuthNotConfiguredError";
}

export type AuthConfig = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
  sessionKey: Buffer;
  tokenKey: Buffer;
};

export function isAuthConfigured(): boolean {
  const parsed = parseServerEnv();
  return parsed.ok && configuredFeatures(parsed.env).snaptradeOAuth;
}

export function getAuthConfig(): AuthConfig {
  const env = serverEnv();
  const {
    SNAPTRADE_OAUTH_CLIENT_ID: clientId,
    SNAPTRADE_OAUTH_CLIENT_SECRET: clientSecret,
    SNAPTRADE_OAUTH_REDIRECT_URI: redirectUri,
    SESSION_SECRET: sessionSecret,
    TOKEN_ENCRYPTION_KEY: tokenKey,
  } = env;
  if (!configuredFeatures(env).snaptradeOAuth || !clientId || !clientSecret || !redirectUri || !sessionSecret || !tokenKey) {
    throw new AuthNotConfiguredError("SnapTrade sign-in is not configured");
  }

  const scopes = env.SNAPTRADE_OAUTH_SCOPES.split(/\s+/).filter(Boolean);
  if (!scopes.includes("openid") || !scopes.includes("read")) {
    throw new AuthNotConfiguredError("SNAPTRADE_OAUTH_SCOPES must include openid and read");
  }

  return {
    issuer: env.SNAPTRADE_ISSUER.replace(/\/+$/, ""),
    clientId,
    clientSecret,
    redirectUri,
    scopes,
    sessionKey: Buffer.from(sessionSecret, "base64"),
    tokenKey: Buffer.from(tokenKey, "base64"),
  };
}
