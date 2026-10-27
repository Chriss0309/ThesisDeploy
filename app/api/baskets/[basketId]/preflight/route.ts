import type { NextRequest } from "next/server";
import { z } from "zod";

import { errorResponse, executionErrorResponse, guardRequest, noStoreJson, resolveActor } from "@/lib/execution/http";
import { ActionPreflightSchema } from "@/lib/execution/schema";
import { actionPreflight } from "@/lib/theses/service";

// One SnapTrade quotes call for a signed-in basket.
export const maxDuration = 30;

/** Pre-flight for `{ kind: "rebalance" | "close" }` on a saved basket, signed in or guest. */
export async function POST(request: NextRequest, context: RouteContext<"/api/baskets/[basketId]/preflight">) {
  const blocked = guardRequest(request, { json: true });
  if (blocked) return blocked;
  const { basketId } = await context.params;
  if (!z.uuid().safeParse(basketId).success) return errorResponse(404, "not_found", "Basket not found.");
  const parsed = ActionPreflightSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_request", "Choose rebalance or close.");
  try {
    return noStoreJson(await actionPreflight(await resolveActor(request), basketId, parsed.data.kind));
  } catch (error) {
    return executionErrorResponse(error, "action-preflight");
  }
}
