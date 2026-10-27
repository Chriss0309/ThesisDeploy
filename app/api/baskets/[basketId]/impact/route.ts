import type { NextRequest } from "next/server";
import { z } from "zod";

import { errorResponse, executionErrorResponse, guardRequest, noStoreJson, resolveActor } from "@/lib/execution/http";
import { checkImpact } from "@/lib/execution/impact";
import { ImpactRequestSchema } from "@/lib/execution/schema";

// One SnapTrade order-impact call per leg, 1.1 seconds apart (8 legs at most).
export const maxDuration = 30;

/** Brokerage preview for a Live pre-flight: `{ kind, preflightId }`. Places nothing. */
export async function POST(request: NextRequest, context: RouteContext<"/api/baskets/[basketId]/impact">) {
  const blocked = guardRequest(request, { json: true });
  if (blocked) return blocked;
  const { basketId } = await context.params;
  if (!z.uuid().safeParse(basketId).success) return errorResponse(404, "not_found", "Basket not found.");
  const parsed = ImpactRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_request", "Invalid preview request.");
  try {
    return noStoreJson(await checkImpact(await resolveActor(request), basketId, parsed.data));
  } catch (error) {
    return executionErrorResponse(error, "impact");
  }
}
