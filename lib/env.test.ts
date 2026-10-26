import { describe, expect, it } from "vitest";

import { configuredFeatures, parseServerEnv } from "@/lib/env";

const key32 = Buffer.alloc(32, 7).toString("base64");

describe("parseServerEnv", () => {
  it("accepts an empty environment and applies defaults", () => {
    const result = parseServerEnv({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.env.SNAPTRADE_ISSUER).toBe("https://api.snaptrade.com");
    expect(result.env.SNAPTRADE_OAUTH_SCOPES).toBe("openid email profile read trade");
    expect(result.env.ANTHROPIC_MODEL).toBe("claude-sonnet-5-5");
    expect(result.env.LIVE_TRADING_ENABLED).toBe(false);
  });

  it("treats blank values as unset", () => {
    const result = parseServerEnv({ APP_BASE_URL: "  ", LIVE_TRADING_ENABLED: "" });
    expect(result).toMatchObject({ ok: true, env: { LIVE_TRADING_ENABLED: false } });
  });

  it("reports invalid variable names without their values", () => {
    const secret = "not-a-32-byte-key";
    const result = parseServerEnv({
      TOKEN_ENCRYPTION_KEY: secret,
      SNAPTRADE_OAUTH_REDIRECT_URI: "callback",
      LIVE_TRADING_ENABLED: "maybe",
    });
    expect(result).toEqual({
      ok: false,
      invalid: ["LIVE_TRADING_ENABLED", "SNAPTRADE_OAUTH_REDIRECT_URI", "TOKEN_ENCRYPTION_KEY"],
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("rejects base64 keys that are not 32 bytes", () => {
    const result = parseServerEnv({ SESSION_SECRET: Buffer.alloc(16).toString("base64") });
    expect(result).toEqual({ ok: false, invalid: ["SESSION_SECRET"] });
  });
});

describe("configuredFeatures", () => {
  it("requires every OAuth and session variable before enabling sign-in", () => {
    const base = {
      SNAPTRADE_OAUTH_CLIENT_ID: "client",
      SNAPTRADE_OAUTH_CLIENT_SECRET: "secret",
      SNAPTRADE_OAUTH_REDIRECT_URI: "http://127.0.0.1:3000/api/auth/callback",
      SESSION_SECRET: key32,
    };
    const partial = parseServerEnv(base);
    const full = parseServerEnv({ ...base, TOKEN_ENCRYPTION_KEY: key32, LIVE_TRADING_ENABLED: "true" });
    if (!partial.ok || !full.ok) throw new Error("expected valid env");

    expect(configuredFeatures(partial.env).snaptradeOAuth).toBe(false);
    expect(configuredFeatures(full.env)).toEqual({
      snaptradeOAuth: true,
      anthropic: false,
      liveTrading: true,
    });
  });
});
