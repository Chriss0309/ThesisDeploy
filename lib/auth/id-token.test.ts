import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTVerifyGetKey,
  type CryptoKey,
} from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import { verifyIdToken } from "@/lib/auth/id-token";

const ISSUER = "https://api.snaptrade.com";
const CLIENT_ID = "client-123";
const NONCE = "nonce-abc";
const SUB = "5b1a2c4e-0000-4000-8000-000000000042";

let privateKey: CryptoKey;
let jwks: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  jwks = createLocalJWKSet({
    keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" }],
  });
});

type Overrides = {
  claims?: Record<string, unknown>;
  issuer?: string;
  audience?: string | string[];
  issuedAt?: number;
  expiresAt?: number;
  kid?: string;
};

function sign(overrides: Overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ nonce: NONCE, email: "a@example.com", email_verified: true, ...overrides.claims })
    .setProtectedHeader({ alg: "RS256", kid: overrides.kid ?? "k1" })
    .setIssuer(overrides.issuer ?? ISSUER)
    .setSubject(SUB)
    .setAudience(overrides.audience ?? CLIENT_ID)
    .setIssuedAt(overrides.issuedAt ?? now)
    .setExpirationTime(overrides.expiresAt ?? now + 600)
    .sign(privateKey);
}

const verify = (token: string, nonce = NONCE) =>
  verifyIdToken(token, { jwks, issuer: ISSUER, clientId: CLIENT_ID, nonce });

describe("verifyIdToken", () => {
  it("returns identity claims for a valid token", async () => {
    await expect(verify(await sign({ claims: { name: "Ada" } }))).resolves.toEqual({
      sub: SUB,
      email: "a@example.com",
      emailVerified: true,
      name: "Ada",
    });
  });

  it("rejects a nonce mismatch", async () => {
    await expect(verify(await sign(), "other-nonce")).rejects.toThrow("nonce_mismatch");
  });

  it("rejects the wrong issuer and audience", async () => {
    await expect(verify(await sign({ issuer: "https://evil.example" }))).rejects.toThrow();
    await expect(verify(await sign({ audience: "someone-else" }))).rejects.toThrow();
  });

  it("rejects expired and implausibly old tokens", async () => {
    const now = Math.floor(Date.now() / 1000);
    await expect(verify(await sign({ issuedAt: now - 7200, expiresAt: now - 3600 }))).rejects.toThrow();
    await expect(verify(await sign({ issuedAt: now - 3600, expiresAt: now + 600 }))).rejects.toThrow();
  });

  it("rejects an unknown signing key", async () => {
    await expect(verify(await sign({ kid: "unknown" }))).rejects.toThrow();
  });

  it("rejects HS256 tokens (algorithm confusion)", async () => {
    const forged = await new SignJWT({ nonce: NONCE })
      .setProtectedHeader({ alg: "HS256", kid: "k1" })
      .setIssuer(ISSUER)
      .setSubject(SUB)
      .setAudience(CLIENT_ID)
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(new TextEncoder().encode("a-shared-secret-of-sufficient-length!"));
    await expect(verify(forged)).rejects.toThrow();
  });

  it("requires azp when there are multiple audiences", async () => {
    await expect(verify(await sign({ audience: [CLIENT_ID, "other"] }))).rejects.toThrow(
      "azp_mismatch",
    );
    await expect(
      verify(await sign({ audience: [CLIENT_ID, "other"], claims: { azp: CLIENT_ID } })),
    ).resolves.toMatchObject({ sub: SUB });
  });

  it("drops malformed optional claims instead of failing or trusting them", async () => {
    await expect(
      verify(await sign({ claims: { email_verified: "true", name: 42 } })),
    ).resolves.toEqual({ sub: SUB, email: "a@example.com", emailVerified: null, name: null });
  });

  it("requires a nonce claim", async () => {
    await expect(verify(await sign({ claims: { nonce: undefined } }))).rejects.toThrow();
  });
});
