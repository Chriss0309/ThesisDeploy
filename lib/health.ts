import { checkDatabase } from "@/lib/db/check";
import { configuredFeatures, parseServerEnv, type EnvSource } from "@/lib/env";

export type Check = { status: "ok" | "error" } & Record<string, unknown>;

export type HealthReport = {
  status: "ok" | "degraded";
  service: "thesisdeploy";
  environment: string;
  commit: string | null;
  time: string;
  checks: Record<string, Check>;
};

export type DatabaseProbe = (url: string) => Promise<Check>;

export async function getHealth(
  source: EnvSource = process.env,
  probe: DatabaseProbe = checkDatabase,
): Promise<HealthReport> {
  const parsed = parseServerEnv(source);
  const databaseUrl = parsed.ok ? parsed.env.DATABASE_URL : undefined;

  const checks: Record<string, Check> = {
    env: parsed.ok
      ? { status: "ok", features: configuredFeatures(parsed.env) }
      : { status: "error", invalid: parsed.invalid },
    database: databaseUrl
      ? await probe(databaseUrl)
      : { status: "error", reason: parsed.ok ? "not_configured" : "env_invalid" },
  };

  return {
    status: Object.values(checks).every((check) => check.status === "ok")
      ? "ok"
      : "degraded",
    service: "thesisdeploy",
    environment: source.VERCEL_ENV ?? source.NODE_ENV ?? "unknown",
    commit: source.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
    time: new Date().toISOString(),
    checks,
  };
}
