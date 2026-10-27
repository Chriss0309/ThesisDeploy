import { z } from "zod";

import type { AuthConfig } from "@/lib/auth/config";

const metadataSchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.url(),
  token_endpoint: z.url(),
  revocation_endpoint: z.url(),
  jwks_uri: z.url(),
  scopes_supported: z.array(z.string()).optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
  id_token_signing_alg_values_supported: z.array(z.string()).optional(),
  authorization_response_iss_parameter_supported: z.boolean().optional(),
});

export type ProviderMetadata = z.infer<typeof metadataSchema>;

export class DiscoveryError extends Error {
  name = "DiscoveryError";
}

export function validateMetadata(
  raw: unknown,
  config: Pick<AuthConfig, "issuer" | "scopes">,
): ProviderMetadata {
  const metadata = metadataSchema.parse(raw);
  if (metadata.issuer !== config.issuer) {
    throw new DiscoveryError("Discovery issuer does not match SNAPTRADE_ISSUER");
  }
  if (!metadata.code_challenge_methods_supported?.includes("S256")) {
    throw new DiscoveryError("Provider does not advertise PKCE S256");
  }
  if (
    metadata.id_token_signing_alg_values_supported &&
    !metadata.id_token_signing_alg_values_supported.includes("RS256")
  ) {
    throw new DiscoveryError("Provider does not sign id_tokens with RS256");
  }
  const unsupported = config.scopes.filter(
    (scope) => metadata.scopes_supported && !metadata.scopes_supported.includes(scope),
  );
  if (unsupported.length > 0) {
    throw new DiscoveryError(`Unsupported scopes requested: ${unsupported.join(" ")}`);
  }
  return metadata;
}

const TTL_MS = 60 * 60 * 1000;
let cached: { issuer: string; metadata: ProviderMetadata; expiresAt: number } | undefined;

export async function getProviderMetadata(
  config: Pick<AuthConfig, "issuer" | "scopes">,
): Promise<ProviderMetadata> {
  if (cached && cached.issuer === config.issuer && cached.expiresAt > Date.now()) {
    return cached.metadata;
  }
  const response = await fetch(`${config.issuer}/.well-known/openid-configuration`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new DiscoveryError(`Discovery failed with HTTP ${response.status}`);
  }
  const metadata = validateMetadata(await response.json(), config);
  cached = { issuer: config.issuer, metadata, expiresAt: Date.now() + TTL_MS };
  return metadata;
}
