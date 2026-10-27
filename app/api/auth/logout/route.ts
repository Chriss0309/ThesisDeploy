import type { NextRequest } from "next/server";

import { getAuthConfig, isAuthConfigured } from "@/lib/auth/config";
import { signOut } from "@/lib/auth/flow";
import { publicOrigin, redirectHome, type AuthNotice } from "@/lib/auth/http";
import { SESSION_COOKIE } from "@/lib/auth/sessions";

export const maxDuration = 15;

export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (origin && origin !== publicOrigin(request)) {
    return new Response("Cross-origin sign-out rejected", { status: 403 });
  }

  const disconnect = request.nextUrl.searchParams.get("disconnect") === "1";
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  let notice: AuthNotice = "signed_out";
  if (token && isAuthConfigured()) {
    const { revoked } = await signOut(getAuthConfig(), token, { disconnect });
    if (disconnect) notice = revoked ? "disconnected" : "disconnect_partial";
  }

  const response = redirectHome(notice);
  response.cookies.delete(SESSION_COOKIE);
  return response;
}
