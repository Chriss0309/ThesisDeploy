import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { decrypt, encrypt, pkceChallenge, randomToken } from "@/lib/auth/crypto";

describe("pkceChallenge", () => {
  it("matches the RFC 7636 Appendix B example", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("produces verifiers within the RFC length bounds", () => {
    const verifier = randomToken(64);
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("encrypt / decrypt", () => {
  const key = randomBytes(32);

  it("round-trips and never contains the plaintext", () => {
    const sealed = encrypt(key, "refresh-token-value", "ctx");
    expect(sealed).not.toContain("refresh-token-value");
    expect(decrypt(key, sealed, "ctx")).toBe("refresh-token-value");
  });

  it("uses a fresh IV for every encryption", () => {
    expect(encrypt(key, "same", "ctx")).not.toBe(encrypt(key, "same", "ctx"));
  });

  it("rejects a ciphertext moved to another context", () => {
    const sealed = encrypt(key, "token", "oauth_grants.access_token:user-a");
    expect(() => decrypt(key, sealed, "oauth_grants.access_token:user-b")).toThrow();
  });

  it("rejects tampering and the wrong key", () => {
    const sealed = encrypt(key, "token", "ctx");
    const [version, iv, ciphertext, tag] = sealed.split(".");
    const flipped = Buffer.from(ciphertext, "base64url");
    flipped[0] ^= 1;
    expect(() =>
      decrypt(key, [version, iv, flipped.toString("base64url"), tag].join("."), "ctx"),
    ).toThrow();
    expect(() => decrypt(randomBytes(32), sealed, "ctx")).toThrow();
    expect(() => decrypt(key, "not-a-ciphertext", "ctx")).toThrow();
  });
});
