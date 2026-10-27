import type { NextRequest } from "next/server";

import { publicOrigin } from "@/lib/auth/http";
import { ReauthRequiredError } from "@/lib/auth/vault";
import { describeError } from "@/lib/errors";
import { ThesisRequestSchema, type ThesisRequest } from "@/lib/thesis/schema";
import { ThesisError } from "@/lib/thesis/service";
import type { ThesisErrorBody } from "@/lib/thesis/types";

export function errorResponse(
  status: number,
  code: string,
  message: string,
  retryAfterSeconds: number | null = null,
): Response {
  const body: ThesisErrorBody = { error: { code, message, retryAfterSeconds } };
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (retryAfterSeconds) headers["Retry-After"] = String(Math.ceil(retryAfterSeconds));
  return Response.json(body, { status, headers });
}

/**
 * Same-origin JSON only. A cross-site page can't send application/json
 * without a CORS preflight, which these routes never approve, so other sites
 * can't spend generations from a visitor's browser.
 */
export async function readThesisRequest(
  request: NextRequest,
): Promise<{ ok: true; body: ThesisRequest } | { ok: false; response: Response }> {
  const origin = request.headers.get("origin");
  if (origin && origin !== publicOrigin(request)) {
    return { ok: false, response: errorResponse(403, "cross_origin", "Cross-origin requests are not allowed.") };
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return { ok: false, response: errorResponse(415, "unsupported_media_type", "Send JSON.") };
  }
  const parsed = ThesisRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return {
      ok: false,
      response: errorResponse(400, "invalid_request", "Check the thesis, budget, and account, then try again."),
    };
  }
  return { ok: true, body: parsed.data };
}

export function thesisErrorResponse(error: unknown, scope: string): Response {
  if (error instanceof ThesisError) {
    return errorResponse(error.status, error.code, error.message, error.retryAfterSeconds);
  }
  if (error instanceof ReauthRequiredError) {
    return errorResponse(401, "reauth_required", "Your SnapTrade access expired. Sign in again to continue.");
  }
  console.error(`[${scope}] thesis failed`, describeError(error));
  return errorResponse(500, "internal", "Something went wrong building this basket. Try again.");
}
