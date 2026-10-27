import type { NextRequest } from "next/server";
import { z } from "zod";

import { errorResponse, executionErrorResponse, guardRequest, noStoreJson, resolveActor } from "@/lib/execution/http";
import { reconcileExecution } from "@/lib/execution/reconcile";

/**
 * Checks a Live execution's open orders at the broker. At most one SnapTrade
 * call per 15 seconds per execution; earlier calls return the current state
 * and `nextCheckAt`.
 */
export async function POST(request: NextRequest, context: RouteContext<"/api/executions/[executionId]/reconcile">) {
  const blocked = guardRequest(request);
  if (blocked) return blocked;
  const { executionId } = await context.params;
  if (!z.uuid().safeParse(executionId).success) return errorResponse(404, "not_found", "Execution not found.");
  try {
    return noStoreJson(await reconcileExecution(await resolveActor(request), executionId));
  } catch (error) {
    return executionErrorResponse(error, "reconcile");
  }
}
