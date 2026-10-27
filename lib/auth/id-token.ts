import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { z } from "zod";

const jwksByUri = new Map<string, JWTVerifyGetKey>();

// jose caches keys and refetches when it sees an unknown `kid`, so signing-key
// rotation needs no deploy.
export function remoteJwks(jwksUri: string): JWTVerifyGetKey {
  let jwks = jwksByUri.get(jwksUri);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(jwksUri), { timeoutDuration: 5_000 });
    jwksByUri.set(jwksUri, jwks);
  }
  return jwks;
}

// Only sub and nonce gate sign-in. A malformed optional profile claim is
// dropped, so an unexpected email_verified can never be read as verified.
const claimsSchema = z.object({
  sub: z.string().min(1).max(255),
  nonce: z.string(),
  email: z.string().optional().catch(undefined),
  email_verified: z.boolean().optional().catch(undefined),
  name: z.string().optional().catch(undefined),
});

export type IdentityClaims = {
  sub: string;
  email: string | null;
  emailVerified: boolean | null;
  name: string | null;
};

export class IdTokenError extends Error {
  name = "IdTokenError";
  constructor(readonly code: string) {
    super(`id_token rejected: ${code}`);
  }
}

export async function verifyIdToken(
  idToken: string,
  options: { jwks: JWTVerifyGetKey; issuer: string; clientId: string; nonce: string },
): Promise<IdentityClaims> {
  const { payload } = await jwtVerify(idToken, options.jwks, {
    issuer: options.issuer,
    audience: options.clientId,
    algorithms: ["RS256"],
    requiredClaims: ["sub", "iat", "exp", "nonce"],
    maxTokenAge: "10 minutes",
    clockTolerance: "60 seconds",
  });

  if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== options.clientId) {
    throw new IdTokenError("azp_mismatch");
  }
  const claims = claimsSchema.safeParse(payload);
  if (!claims.success) throw new IdTokenError("invalid_claims");
  if (claims.data.nonce !== options.nonce) throw new IdTokenError("nonce_mismatch");

  return {
    sub: claims.data.sub,
    email: claims.data.email ?? null,
    emailVerified: claims.data.email_verified ?? null,
    name: claims.data.name ?? null,
  };
}
