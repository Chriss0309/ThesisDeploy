import { getDb } from "@/lib/db/client";
import type { Check } from "@/lib/health";

// Must match the tables the migrations create; lib/db/migrations.test.ts enforces it.
export const APP_TABLES = [
  "app_users",
  "sessions",
  "oauth_login_attempts",
  "oauth_grants",
  "events",
  "api_calls",
  "account_snapshots",
  "theses",
  "thesis_candidates",
] as const;

class TimeoutError extends Error {
  name = "TimeoutError";
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function errorCode(error: unknown) {
  if (error && typeof error === "object" && "code" in error) return String(error.code);
  return error instanceof Error ? error.name : "unknown";
}

// One round trip: proves connectivity, that migrations ran, and that RLS is on.
export async function checkDatabase(url: string, timeoutMs = 3000): Promise<Check> {
  const startedAt = performance.now();
  const latencyMs = () => Math.round(performance.now() - startedAt);

  try {
    const rows = await withTimeout(
      getDb(url).$queryRaw<{ name: string; rls: boolean }[]>`
        select c.relname as name, c.relrowsecurity as rls
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relkind = 'r'
          and c.relname = any(${[...APP_TABLES]})
      `,
      timeoutMs,
    );

    const rlsByTable = new Map(rows.map((row) => [row.name, row.rls]));
    const missingTables = APP_TABLES.filter((name) => !rlsByTable.has(name));
    const rlsDisabled = APP_TABLES.filter((name) => rlsByTable.get(name) === false);
    const ok = missingTables.length === 0 && rlsDisabled.length === 0;

    return {
      status: ok ? "ok" : "error",
      latencyMs: latencyMs(),
      ...(missingTables.length > 0 && { missingTables }),
      ...(rlsDisabled.length > 0 && { rlsDisabled }),
    };
  } catch (error) {
    // Driver errors can include connection details; log only the code.
    console.error("[health] database check failed", { code: errorCode(error) });
    return { status: "error", reason: "unreachable", latencyMs: latencyMs() };
  }
}
