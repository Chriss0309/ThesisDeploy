import { TRPCError } from "@trpc/server";

/** A failure whose code and message are safe to show; `status` is the HTTP status it maps to. */
export class AppError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly extra: { retryAfterSeconds?: number | null; executionId?: string | null } = {},
  ) {
    super(message);
  }
}

// Safe-to-log summary of an error: names and codes only, never messages,
// which can echo connection strings, tokens, or response bodies.
export function describeError(error: unknown): Record<string, string | number> {
  if (!error || typeof error !== "object") return { name: "unknown" };
  const summary: Record<string, string | number> = {
    name: error instanceof Error ? error.name : "unknown",
  };
  for (const key of ["code", "status", "operation", "claim"] as const) {
    const value = (error as Record<string, unknown>)[key];
    if (typeof value === "string" || typeof value === "number") summary[key] = value;
  }
  return summary;
}

/** What a procedure actually threw, for Server Components that tell failures apart. */
export const procedureFailure = (error: unknown): unknown => (error instanceof TRPCError ? error.cause : error);
