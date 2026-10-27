import type { NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth/current-user";
import { serverEnv } from "@/lib/env";
import { describeError } from "@/lib/errors";
import { errorResponse, guestKeyFor, guestToken, noStoreJson } from "@/lib/execution/http";
import { WINDOW_DAYS, globalTelemetry, telemetrySnapshot } from "@/lib/telemetry/metrics";
import type { TelemetryPayload } from "@/lib/telemetry/types";

export const maxDuration = 10;

/** Aggregates only: everyone's (cached for a minute) and this browser's own (its session and demo cookie). */
export async function GET(request: NextRequest) {
  if (!serverEnv().DATABASE_URL) {
    return errorResponse(503, "not_configured", "Telemetry needs the database, which isn't configured on this deployment.");
  }
  try {
    const user = await getCurrentUser();
    const token = guestToken(request);
    const scope = { userId: user?.id ?? null, guestKey: token ? guestKeyFor(token) : null };
    const now = new Date();
    const [global, you] = await Promise.all([
      globalTelemetry(now.getTime()),
      scope.userId || scope.guestKey ? telemetrySnapshot(scope, now) : null,
    ]);
    const payload: TelemetryPayload = {
      windowDays: WINDOW_DAYS,
      generatedAt: now.toISOString(),
      global,
      you,
      viewer: scope.userId ? "user" : scope.guestKey ? "guest" : "anonymous",
    };
    return noStoreJson(payload);
  } catch (error) {
    console.error("[telemetry] aggregate failed", describeError(error));
    return errorResponse(500, "internal", "Telemetry couldn't be loaded. Try again.");
  }
}
