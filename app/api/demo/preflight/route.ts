import type { NextRequest } from "next/server";

import { clientIp } from "@/lib/auth/http";
import {
  errorResponse,
  executionErrorResponse,
  guardRequest,
  guestKeyFor,
  guestToken,
  newGuestToken,
  noStoreJson,
  withGuestCookie,
} from "@/lib/execution/http";
import { PreflightRequestSchema } from "@/lib/execution/schema";
import { preflightForGuest } from "@/lib/execution/service";
import { guestClientKey } from "@/lib/thesis/rate-limit";

export async function POST(request: NextRequest) {
  const blocked = guardRequest(request, { json: true });
  if (blocked) return blocked;
  const parsed = PreflightRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_request", "Check the basket, then try pre-flight again.");

  const existing = guestToken(request);
  const token = existing ?? newGuestToken();
  const guest = {
    guestKey: guestKeyFor(token),
    // Daily limits follow the visitor's address, so clearing cookies doesn't reset them.
    guestClient: guestClientKey(clientIp(request) ?? `cookie:${token}`),
  };
  try {
    const response = noStoreJson(await preflightForGuest(guest, parsed.data));
    return existing ? response : withGuestCookie(response, request, token);
  } catch (error) {
    return executionErrorResponse(error, "demo-preflight");
  }
}
