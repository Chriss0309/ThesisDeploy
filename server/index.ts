import { authRouter } from "@/server/routers/auth";
import { basketsRouter } from "@/server/routers/baskets";
import { demoRouter } from "@/server/routers/demo";
import { executionsRouter } from "@/server/routers/executions";
import { portfolioRouter } from "@/server/routers/portfolio";
import { telemetryRouter } from "@/server/routers/telemetry";
import { thesesRouter } from "@/server/routers/theses";
import { router } from "@/server/trpc";

export const appRouter = router({
  auth: authRouter,
  baskets: basketsRouter,
  demo: demoRouter,
  executions: executionsRouter,
  portfolio: portfolioRouter,
  telemetry: telemetryRouter,
  theses: thesesRouter,
});

export type AppRouter = typeof appRouter;
