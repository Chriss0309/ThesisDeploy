import type { NextRequest } from "next/server";
import { z } from "zod";

import { publicOrigin } from "@/lib/auth/http";
import { getCurrentUser } from "@/lib/auth/current-user";
import { recordEvent } from "@/lib/telemetry/events";
import { errorResponse } from "@/lib/thesis/http";
import { thesisOwnedBy } from "@/lib/thesis/store";

const EditSchema = z.object({
  action: z.enum(["remove", "restore", "reweight", "step"]),
  symbol: z.string().min(1).max(24),
});

// Feeds the basket edit rate: suggested tickers removed or resized before deploying.
export async function POST(request: NextRequest, context: RouteContext<"/api/theses/[thesisId]/edits">) {
  const origin = request.headers.get("origin");
  if (origin && origin !== publicOrigin(request)) {
    return errorResponse(403, "cross_origin", "Cross-origin requests are not allowed.");
  }
  const user = await getCurrentUser();
  if (!user) return errorResponse(401, "signed_out", "Sign in to record edits.");

  const { thesisId } = await context.params;
  const edit = EditSchema.safeParse(await request.json().catch(() => null));
  if (!edit.success || !z.uuid().safeParse(thesisId).success) {
    return errorResponse(400, "invalid_request", "Invalid edit.");
  }
  if (!(await thesisOwnedBy(thesisId, user.id))) return errorResponse(404, "not_found", "Thesis not found.");

  await recordEvent("basket_edited", { thesisId, ...edit.data }, user.id);
  return new Response(null, { status: 204 });
}
