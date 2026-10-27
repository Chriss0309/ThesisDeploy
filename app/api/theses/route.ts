import type { NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth/current-user";
import { snapTradeContext } from "@/lib/snaptrade/client";
import { errorResponse, readThesisRequest, thesisErrorResponse } from "@/lib/thesis/http";
import { createThesis } from "@/lib/thesis/service";

// A Claude call (typically 10–40s) plus SnapTrade quotes.
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const parsed = await readThesisRequest(request);
  if (!parsed.ok) return parsed.response;

  const user = await getCurrentUser();
  if (!user) return errorResponse(401, "signed_out", "Sign in with SnapTrade to generate a thesis.");

  try {
    const payload = await createThesis(snapTradeContext(user.id), parsed.body);
    return Response.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return thesisErrorResponse(error, "theses");
  }
}
