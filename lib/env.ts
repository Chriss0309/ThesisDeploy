import { z } from "zod";

const base64Key32 = z
  .base64()
  .refine((value) => Buffer.from(value, "base64").length === 32, {
    message: "must be 32 random bytes, base64-encoded",
  });

// Every variable is optional so builds and previews work without secrets;
// features check `configuredFeatures` before using their variables.
const serverEnvSchema = z.object({
  APP_BASE_URL: z.url().optional(),
  DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\//, "must be a postgres:// connection string")
    .optional(),
  SNAPTRADE_ISSUER: z.url().default("https://api.snaptrade.com"),
  SNAPTRADE_OAUTH_CLIENT_ID: z.string().optional(),
  SNAPTRADE_OAUTH_CLIENT_SECRET: z.string().optional(),
  SNAPTRADE_OAUTH_REDIRECT_URI: z.url().optional(),
  SNAPTRADE_OAUTH_SCOPES: z.string().default("openid email profile read trade"),
  SESSION_SECRET: base64Key32.optional(),
  TOKEN_ENCRYPTION_KEY: base64Key32.optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-5-5"),
  LIVE_TRADING_ENABLED: z.stringbool().default(false),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export type EnvSource = Record<string, string | undefined>;

export type EnvParseResult =
  | { ok: true; env: ServerEnv }
  | { ok: false; invalid: string[] };

function withoutBlanks(source: EnvSource) {
  return Object.fromEntries(
    Object.entries(source).filter(
      ([, value]) => value !== undefined && value.trim() !== "",
    ),
  );
}

// Reports only variable names on failure, never values.
export function parseServerEnv(source: EnvSource = process.env): EnvParseResult {
  const result = serverEnvSchema.safeParse(withoutBlanks(source));
  if (result.success) return { ok: true, env: result.data };
  const invalid = new Set(result.error.issues.map((issue) => String(issue.path[0])));
  return { ok: false, invalid: [...invalid].sort() };
}

export function serverEnv(): ServerEnv {
  const result = parseServerEnv();
  if (!result.ok) {
    throw new Error(`Invalid environment variables: ${result.invalid.join(", ")}`);
  }
  return result.env;
}

export function configuredFeatures(env: ServerEnv) {
  return {
    snaptradeOAuth: Boolean(
      env.SNAPTRADE_OAUTH_CLIENT_ID &&
        env.SNAPTRADE_OAUTH_CLIENT_SECRET &&
        env.SNAPTRADE_OAUTH_REDIRECT_URI &&
        env.SESSION_SECRET &&
        env.TOKEN_ENCRYPTION_KEY,
    ),
    anthropic: Boolean(env.ANTHROPIC_API_KEY),
    liveTrading: env.LIVE_TRADING_ENABLED,
  };
}
