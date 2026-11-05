import { cookies } from "next/headers";
import type { NextRequest } from "next/server";

import { GUEST_COOKIE } from "@/constants/execution";
import { getCurrentUser } from "@/lib/auth/current-user";
import { clientIp, isSecure, publicOrigin } from "@/lib/auth/http";
import { SESSION_COOKIE } from "@/lib/auth/sessions";
import { AppError } from "@/lib/errors";
import { parseGuestToken } from "@/lib/execution/guest";
import { PublicError } from "@/server/trpc";
import type { TrpcContext } from "@/types/trpc";

/**
 * Same-origin requests only. Cookies are SameSite=Lax, and a cross-site page
 * can't send application/json without a CORS preflight, which is never approved.
 */
export async function createHttpContext(request: NextRequest, resHeaders: Headers): Promise<TrpcContext> {
  const origin = publicOrigin(request);
  const sent = request.headers.get("origin");
  if (sent && sent !== origin) {
    throw new PublicError(new AppError("cross_origin", 403, "Cross-origin requests are not allowed."));
  }
  return {
    user: await getCurrentUser(),
    sessionToken: request.cookies.get(SESSION_COOKIE)?.value ?? null,
    guestToken: parseGuestToken(request.cookies.get(GUEST_COOKIE)?.value),
    clientIp: clientIp(request),
    secureCookies: isSecure(origin),
    resHeaders,
  };
}

/** For Server Components, which can't set cookies: anything written to `resHeaders` goes nowhere. */
export async function createServerContext(): Promise<TrpcContext> {
  const [user, store] = await Promise.all([getCurrentUser(), cookies()]);
  return {
    user,
    sessionToken: store.get(SESSION_COOKIE)?.value ?? null,
    guestToken: parseGuestToken(store.get(GUEST_COOKIE)?.value),
    clientIp: null,
    secureCookies: false,
    resHeaders: new Headers(),
  };
}
