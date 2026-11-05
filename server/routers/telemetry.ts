import { serverEnv } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { guestKeyFor } from "@/lib/execution/guest";
import { WINDOW_DAYS, globalTelemetry, telemetrySnapshot } from "@/lib/telemetry/metrics";
import { publicProcedure, router } from "@/server/trpc";
import type { TelemetryPayload } from "@/types/telemetry";

export const telemetryRouter = router({
  /** Aggregates only: everyone's (cached for a minute) and this browser's own (its session and demo cookie). */
  get: publicProcedure
    .meta({ failure: "Telemetry couldn't be loaded. Try again." })
    .query(async ({ ctx }): Promise<TelemetryPayload> => {
      if (!serverEnv().DATABASE_URL) {
        throw new AppError(
          "not_configured",
          503,
          "Telemetry needs the database, which isn't configured on this deployment.",
        );
      }
      const scope = {
        userId: ctx.user?.id ?? null,
        guestKey: ctx.guestToken ? guestKeyFor(ctx.guestToken) : null,
      };
      const now = new Date();
      const [global, you] = await Promise.all([
        globalTelemetry(now.getTime()),
        scope.userId || scope.guestKey ? telemetrySnapshot(scope, now) : null,
      ]);
      return {
        windowDays: WINDOW_DAYS,
        generatedAt: now.toISOString(),
        global,
        you,
        viewer: scope.userId ? "user" : scope.guestKey ? "guest" : "anonymous",
      };
    }),
});
