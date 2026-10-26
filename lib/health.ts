import { configuredFeatures, parseServerEnv, type EnvSource } from "@/lib/env";

type Check = { status: "ok" | "error" } & Record<string, unknown>;

export type HealthReport = {
  status: "ok" | "degraded";
  service: "thesisdeploy";
  environment: string;
  commit: string | null;
  time: string;
  checks: Record<string, Check>;
};

export function getHealth(source: EnvSource = process.env): HealthReport {
  const parsed = parseServerEnv(source);
  const checks: Record<string, Check> = {
    env: parsed.ok
      ? { status: "ok", features: configuredFeatures(parsed.env) }
      : { status: "error", invalid: parsed.invalid },
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
