import type { NextRequest } from "next/server";

import { errorResponse, readThesisRequest, thesisErrorResponse } from "@/lib/thesis/http";
import { guestClientKey } from "@/lib/thesis/rate-limit";
import { createDemoThesis } from "@/lib/thesis/service";

export const maxDuration = 60;

// Vercel sets both headers from the connecting client and overwrites any
// value the client sent, so they can't be spoofed there.
function clientIp(request: NextRequest): string | null {
  return request.headers.get("x-real-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
}

export async function POST(request: NextRequest) {
  const parsed = await readThesisRequest(request);
  if (!parsed.ok) return parsed.response;

  const ip = clientIp(request);
  if (!ip && !parsed.body.presetKey) {
    return errorResponse(400, "unknown_client", "Custom prompts need a client address. Try a preset.");
  }

  try {
    const payload = await createDemoThesis(parsed.body, { client: guestClientKey(ip ?? "unknown") });
    return Response.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return thesisErrorResponse(error, "demo-theses");
  }
}
