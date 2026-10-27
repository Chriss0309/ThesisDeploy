import type { NextRequest } from "next/server";
import { z } from "zod";

import { errorResponse, executionErrorResponse, guardRequest, noStoreJson, resolveActor } from "@/lib/execution/http";
import { SimulateMoveSchema } from "@/lib/execution/schema";
import { simulateMove } from "@/lib/theses/service";

/** Demo only: scale one stock's fictional price (`{ symbol, change }`) or clear the moves (`{ reset: true }`). */
export async function POST(request: NextRequest, context: RouteContext<"/api/baskets/[basketId]/simulate">) {
  const blocked = guardRequest(request, { json: true });
  if (blocked) return blocked;
  const { basketId } = await context.params;
  if (!z.uuid().safeParse(basketId).success) return errorResponse(404, "not_found", "Basket not found.");
  const parsed = SimulateMoveSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_request", "Pick a stock and a price move.");
  try {
    const moves = await simulateMove(await resolveActor(request), basketId, parsed.data);
    return noStoreJson({ simulatedMoves: moves });
  } catch (error) {
    return executionErrorResponse(error, "simulate-move");
  }
}
