import type { NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth/current-user";
import { errorResponse, executionErrorResponse, guardRequest, noStoreJson } from "@/lib/execution/http";
import { PreflightRequestSchema } from "@/lib/execution/schema";
import { preflightForUser } from "@/lib/execution/service";
import { snapTradeContext } from "@/lib/snaptrade/client";

// One SnapTrade quotes call plus the account list.
export const maxDuration = 30;

export async function POST(request: NextRequest) {
  const blocked = guardRequest(request, { json: true });
  if (blocked) return blocked;
  const parsed = PreflightRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_request", "Check the basket, then try pre-flight again.");

  const user = await getCurrentUser();
  if (!user) return errorResponse(401, "signed_out", "Sign in with SnapTrade to run pre-flight.");
  try {
    return noStoreJson(await preflightForUser(snapTradeContext(user.id), parsed.data));
  } catch (error) {
    return executionErrorResponse(error, "preflight");
  }
}
