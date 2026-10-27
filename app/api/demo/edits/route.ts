import type { NextRequest } from "next/server";

import { publicOrigin } from "@/lib/auth/http";
import { serverEnv } from "@/lib/env";
import { guestKeyFor, guestToken } from "@/lib/execution/http";
import { recordEvent } from "@/lib/telemetry/events";
import { GuestEditSchema, servedToGuest } from "@/lib/thesis/edits";
import { errorResponse } from "@/lib/thesis/http";

// The guest demo's side of the basket edit rate, keyed by the demo cookie.
export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (origin && origin !== publicOrigin(request)) {
    return errorResponse(403, "cross_origin", "Cross-origin requests are not allowed.");
  }
  const token = guestToken(request);
  if (!token) return errorResponse(401, "no_demo_session", "Generate a demo basket first.");
  const edit = GuestEditSchema.safeParse(await request.json().catch(() => null));
  if (!edit.success) return errorResponse(400, "invalid_request", "Invalid edit.");
  if (!serverEnv().DATABASE_URL) return new Response(null, { status: 204 });

  const guestKey = guestKeyFor(token);
  if (!(await servedToGuest(guestKey, edit.data.ref))) return errorResponse(404, "not_found", "Basket not found.");
  await recordEvent("basket_edited", edit.data, { guestKey });
  return new Response(null, { status: 204 });
}
