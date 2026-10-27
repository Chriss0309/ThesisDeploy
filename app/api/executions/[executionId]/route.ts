import type { NextRequest } from "next/server";
import { z } from "zod";

import { errorResponse, executionErrorResponse, guardRequest, noStoreJson, resolveActor } from "@/lib/execution/http";
import { requireExecution } from "@/lib/execution/service";

export async function GET(request: NextRequest, context: RouteContext<"/api/executions/[executionId]">) {
  const blocked = guardRequest(request);
  if (blocked) return blocked;
  const { executionId } = await context.params;
  if (!z.uuid().safeParse(executionId).success) return errorResponse(404, "not_found", "Execution not found.");
  try {
    const owned = await requireExecution(await resolveActor(request), executionId);
    return noStoreJson(owned.view);
  } catch (error) {
    return executionErrorResponse(error, "execution");
  }
}
