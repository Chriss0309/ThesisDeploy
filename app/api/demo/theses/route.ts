import type { NextRequest } from "next/server";

import { clientIp } from "@/lib/auth/http";
import { guestKeyFor, guestToken, newGuestToken, withGuestCookie } from "@/lib/execution/http";
import { errorResponse, readThesisRequest, thesisErrorResponse } from "@/lib/thesis/http";
import { guestClientKey } from "@/lib/thesis/rate-limit";
import { createDemoThesis } from "@/lib/thesis/service";

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const parsed = await readThesisRequest(request);
  if (!parsed.ok) return parsed.response;

  const ip = clientIp(request);
  if (!ip && !parsed.body.presetKey) {
    return errorResponse(400, "unknown_client", "Custom prompts need a client address. Try a preset.");
  }

  // Issue the demo cookie with the first basket, so pre-flight can't mint a second
  // one in parallel and the basket's telemetry already belongs to this visitor.
  const existing = guestToken(request);
  const token = existing ?? newGuestToken();
  try {
    const payload = await createDemoThesis(parsed.body, {
      client: guestClientKey(ip ?? "unknown"),
      key: guestKeyFor(token),
    });
    const response = Response.json(payload, { headers: { "Cache-Control": "no-store" } });
    return existing ? response : withGuestCookie(response, request, token);
  } catch (error) {
    return thesisErrorResponse(error, "demo-theses");
  }
}
