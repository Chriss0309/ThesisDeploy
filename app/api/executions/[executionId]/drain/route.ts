import type { NextRequest } from "next/server";
import { z } from "zod";

import { serverEnv } from "@/lib/env";
import { describeError } from "@/lib/errors";
import { drainExecution } from "@/lib/execution/drain";
import { errorResponse, executionErrorResponse, guardRequest, resolveActor } from "@/lib/execution/http";
import { requireExecution } from "@/lib/execution/service";
import type { DrainEvent } from "@/lib/execution/types";

// The drain loop stops claiming legs after 45 seconds; the client re-POSTs to resume.
export const maxDuration = 60;

/** Streams NDJSON progress (`DrainEvent` per line) while it submits pending legs. */
export async function POST(request: NextRequest, context: RouteContext<"/api/executions/[executionId]/drain">) {
  const blocked = guardRequest(request);
  if (blocked) return blocked;
  const { executionId } = await context.params;
  if (!z.uuid().safeParse(executionId).success) return errorResponse(404, "not_found", "Execution not found.");

  let owned;
  try {
    owned = await requireExecution(await resolveActor(request), executionId);
  } catch (error) {
    return executionErrorResponse(error, "drain");
  }

  const abort = new AbortController();
  request.signal.addEventListener("abort", () => abort.abort(), { once: true });
  const events = drainExecution(owned, {
    signal: abort.signal,
    liveTradingEnabled: serverEnv().LIVE_TRADING_ENABLED,
  });
  const encoder = new TextEncoder();
  const line = (event: DrainEvent) => encoder.encode(`${JSON.stringify(event)}\n`);

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await events.next();
        if (done) return controller.close();
        controller.enqueue(line(value));
      } catch (error) {
        console.error("[drain] stopped", describeError(error));
        controller.enqueue(
          line({ type: "error", code: "internal", message: "The queue stopped unexpectedly. Resume to continue." }),
        );
        controller.close();
      }
    },
    async cancel() {
      abort.abort();
      await events.return(undefined);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
