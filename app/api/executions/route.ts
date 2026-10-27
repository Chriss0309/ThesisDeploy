import type { NextRequest } from "next/server";

import {
  errorResponse,
  executionErrorResponse,
  guardRequest,
  noStoreJson,
  resolveActor,
} from "@/lib/execution/http";
import { CreateExecutionSchema, IdempotencyKeySchema } from "@/lib/execution/schema";
import { createExecution } from "@/lib/execution/service";

/**
 * Confirms a pre-flight: `{ basketId, mode, simulateRejectSeq }` with an
 * `Idempotency-Key` header (a UUID per confirmation). Repeating the request
 * returns the same execution with 200 instead of 201.
 */
export async function POST(request: NextRequest) {
  const blocked = guardRequest(request, { json: true });
  if (blocked) return blocked;
  const key = IdempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  if (!key.success) return errorResponse(400, "idempotency_key_required", "Send an Idempotency-Key header (a UUID).");
  const parsed = CreateExecutionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_request", "Invalid execution request.");

  try {
    const actor = await resolveActor(request);
    const { execution, created } = await createExecution(actor, { ...parsed.data, idempotencyKey: key.data });
    return noStoreJson(execution, created ? 201 : 200);
  } catch (error) {
    return executionErrorResponse(error, "executions");
  }
}
