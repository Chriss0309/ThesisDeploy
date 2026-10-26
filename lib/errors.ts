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
