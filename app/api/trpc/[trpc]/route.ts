import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import type { NextRequest } from "next/server";

import { TRPC_ENDPOINT } from "@/constants/trpc";
import { describeError } from "@/lib/errors";
import { appRouter } from "@/server";
import { createHttpContext } from "@/server/context";

// One value covers every procedure, so it fits the slowest: a Claude call
// (typically 10–40s) plus quotes, and a drain, which stops claiming legs after 45 seconds.
export const maxDuration = 60;

function handler(request: NextRequest) {
  return fetchRequestHandler({
    endpoint: TRPC_ENDPOINT,
    req: request,
    router: appRouter,
    // The stream link needs the batch protocol, but no client sends more than one call.
    // Without a limit, one request could run many expensive procedures under one time budget.
    maxBatchSize: 1,
    createContext: ({ resHeaders }) => createHttpContext(request, resHeaders),
    responseMeta: () => ({
      headers: new Headers({ "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" }),
    }),
    onError({ error, path }) {
      if (error.code === "INTERNAL_SERVER_ERROR") console.error(`[${path ?? "trpc"}] failed`, describeError(error.cause));
    },
  });
}

export { handler as GET, handler as POST };
