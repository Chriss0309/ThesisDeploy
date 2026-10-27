import type { NextRequest } from "next/server";
import { z } from "zod";

import { errorResponse, executionErrorResponse, guardRequest, noStoreJson, resolveActor } from "@/lib/execution/http";
import { cancelExecution } from "@/lib/execution/service";

/** Skips the legs that haven't been submitted; filled legs stay in the basket. */
export async function POST(request: NextRequest, context: RouteContext<"/api/executions/[executionId]/cancel">) {
  const blocked = guardRequest(request);
  if (blocked) return blocked;
  const { executionId } = await context.params;
  if (!z.uuid().safeParse(executionId).success) return errorResponse(404, "not_found", "Execution not found.");
  try {
    return noStoreJson(await cancelExecution(await resolveActor(request), executionId));
  } catch (error) {
    return executionErrorResponse(error, "cancel");
  }
}
