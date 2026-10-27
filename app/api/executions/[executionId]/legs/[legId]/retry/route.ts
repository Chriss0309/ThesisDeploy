import type { NextRequest } from "next/server";
import { z } from "zod";

import { errorResponse, executionErrorResponse, guardRequest, noStoreJson, resolveActor } from "@/lib/execution/http";
import { RetryRequestSchema } from "@/lib/execution/schema";
import { retryLeg } from "@/lib/execution/service";

/**
 * Queues a new attempt, with a new client_order_id, for a rejected or failed
 * leg; an unconfirmed Live leg needs `{ "confirmNotPlaced": true }`. Drain to submit it.
 */
export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/executions/[executionId]/legs/[legId]/retry">,
) {
  const blocked = guardRequest(request);
  if (blocked) return blocked;
  const { executionId, legId } = await context.params;
  if (!z.uuid().safeParse(executionId).success || !z.uuid().safeParse(legId).success) {
    return errorResponse(404, "not_found", "Leg not found.");
  }
  const body = RetryRequestSchema.safeParse(await request.json().catch(() => undefined));
  if (!body.success) return errorResponse(400, "invalid_request", "Invalid retry request.");
  try {
    return noStoreJson(await retryLeg(await resolveActor(request), executionId, legId, body.data));
  } catch (error) {
    return executionErrorResponse(error, "retry");
  }
}
