import { describe, expect, it } from "vitest";

import { validateMetadata } from "@/lib/auth/discovery";

// https://api.snaptrade.com/.well-known/openid-configuration as fetched on 2026-10-26.
const SNAPTRADE_METADATA = {
  issuer: "https://api.snaptrade.com",
  authorization_endpoint: "https://dashboard.snaptrade.com/oauth/authorize",
  token_endpoint: "https://api.snaptrade.com/oauth/token/",
  device_authorization_endpoint: "https://api.snaptrade.com/oauth/device_authorization/",
  introspection_endpoint: "https://api.snaptrade.com/oauth/introspect/",
  revocation_endpoint: "https://api.snaptrade.com/oauth/revoke_token/",
  registration_endpoint: "https://api.snaptrade.com/oauth/register/",
  scopes_supported: ["openid", "profile", "email", "read", "workspaces:read", "trade", "webhook"],
  response_types_supported: ["code"],
  grant_types_supported: [
    "authorization_code",
    "refresh_token",
    "urn:ietf:params:oauth:grant-type:device_code",
  ],
  code_challenge_methods_supported: ["S256"],
  authorization_response_iss_parameter_supported: true,
  token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
  jwks_uri: "https://api.snaptrade.com/.well-known/jwks.json",
  id_token_signing_alg_values_supported: ["RS256"],
  subject_types_supported: ["public"],
};

const config = {
  issuer: "https://api.snaptrade.com",
  scopes: ["openid", "email", "profile", "read", "trade"],
};

describe("validateMetadata", () => {
  it("accepts SnapTrade's published metadata with the default scopes", () => {
    expect(validateMetadata(SNAPTRADE_METADATA, config)).toMatchObject({
      token_endpoint: "https://api.snaptrade.com/oauth/token/",
      jwks_uri: "https://api.snaptrade.com/.well-known/jwks.json",
    });
  });

  it("rejects an issuer that differs from the configured one", () => {
    expect(() =>
      validateMetadata({ ...SNAPTRADE_METADATA, issuer: "https://api.snaptrade.com/" }, config),
    ).toThrow("issuer");
  });

  it("rejects providers without PKCE S256", () => {
    expect(() =>
      validateMetadata({ ...SNAPTRADE_METADATA, code_challenge_methods_supported: ["plain"] }, config),
    ).toThrow("S256");
  });

  it("rejects scopes the provider does not support", () => {
    expect(() =>
      validateMetadata(SNAPTRADE_METADATA, { ...config, scopes: [...config.scopes, "admin"] }),
    ).toThrow("admin");
  });
});
