import { describe, expect, it } from "vitest";

import { configuredFeatures, liveTradingEnabled, parseServerEnv } from "@/lib/env";

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

  it("requires DATABASE_URL to be a postgres connection string", () => {
    expect(parseServerEnv({ DATABASE_URL: "mysql://u:p@host/db" })).toEqual({
      ok: false,
      invalid: ["DATABASE_URL"],
    });
    expect(
      parseServerEnv({ DATABASE_URL: "postgresql://u:p@host:6543/postgres" }).ok,
    ).toBe(true);
  });

  it("requires https for the issuer and redirect URI unless the host is loopback", () => {
    expect(
      parseServerEnv({
        SNAPTRADE_ISSUER: "http://api.snaptrade.com",
        SNAPTRADE_OAUTH_REDIRECT_URI: "http://thesisdeploy.vercel.app/api/auth/callback",
      }),
    ).toEqual({ ok: false, invalid: ["SNAPTRADE_ISSUER", "SNAPTRADE_OAUTH_REDIRECT_URI"] });
    expect(
      parseServerEnv({
        SNAPTRADE_ISSUER: "http://127.0.0.1:4010",
        SNAPTRADE_OAUTH_REDIRECT_URI: "http://127.0.0.1:3000/api/auth/callback",
      }).ok,
    ).toBe(true);
  });

  it("rejects base64 keys that are not 32 bytes", () => {
    const result = parseServerEnv({ SESSION_SECRET: Buffer.alloc(16).toString("base64") });
    expect(result).toEqual({ ok: false, invalid: ["SESSION_SECRET"] });
  });
});

describe("configuredFeatures", () => {
  it("requires every OAuth, session, and database variable before enabling sign-in", () => {
    const base = {
      SNAPTRADE_OAUTH_CLIENT_ID: "client",
      SNAPTRADE_OAUTH_CLIENT_SECRET: "secret",
      SNAPTRADE_OAUTH_REDIRECT_URI: "http://127.0.0.1:3000/api/auth/callback",
      SESSION_SECRET: key32,
      TOKEN_ENCRYPTION_KEY: key32,
    };
    const partial = parseServerEnv(base);
    const full = parseServerEnv({
      ...base,
      DATABASE_URL: "postgresql://u:p@host:6543/postgres",
      LIVE_TRADING_ENABLED: "true",
    });
    if (!partial.ok || !full.ok) throw new Error("expected valid env");

    expect(configuredFeatures(partial.env).snaptradeOAuth).toBe(false);
    expect(configuredFeatures(full.env)).toEqual({
      snaptradeOAuth: true,
      anthropic: false,
      liveTrading: true,
    });
  });

  it("keeps Live trading off on Vercel previews whatever the switch says", () => {
    const on = { LIVE_TRADING_ENABLED: "true" };
    const parse = (extra: Record<string, string>) => {
      const result = parseServerEnv({ ...on, ...extra });
      if (!result.ok) throw new Error("expected valid env");
      return liveTradingEnabled(result.env);
    };
    expect(parse({})).toBe(true);
    expect(parse({ VERCEL_ENV: "production" })).toBe(true);
    expect(parse({ VERCEL_ENV: "preview" })).toBe(false);
    expect(parse({ VERCEL_ENV: "preview", LIVE_TRADING_ENABLED: "false" })).toBe(false);
  });
});
