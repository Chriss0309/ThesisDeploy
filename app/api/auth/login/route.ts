import { NextResponse, connection, type NextRequest } from "next/server";

import { getAuthConfig } from "@/lib/auth/config";
import { safeReturnTo, startLogin } from "@/lib/auth/flow";
import { STATE_COOKIE, isSecure, noStore, publicOrigin, redirectHome } from "@/lib/auth/http";
import { describeError } from "@/lib/errors";

export const maxDuration = 15;

export async function GET(request: NextRequest) {
  await connection();
  const returnTo = safeReturnTo(request.nextUrl.searchParams.get("returnTo"));

  let config;
  try {
    config = getAuthConfig();
  } catch {
    return redirectHome("not_configured");
  }

  // The state cookie must be set on the callback's origin (for example
  // 127.0.0.1 rather than localhost, or production rather than a preview).
  const callbackOrigin = new URL(config.redirectUri).origin;
  if (publicOrigin(request) !== callbackOrigin) {
    const url = new URL("/api/auth/login", callbackOrigin);
    url.searchParams.set("returnTo", returnTo);
    return noStore(NextResponse.redirect(url, 307));
  }

  try {
    const { authorizationUrl, state } = await startLogin(config, returnTo);
    const response = noStore(NextResponse.redirect(authorizationUrl, 303));
    response.cookies.set({
      name: STATE_COOKIE,
      value: state,
      httpOnly: true,
      sameSite: "lax",
      secure: isSecure(callbackOrigin),
      path: "/api/auth",
      maxAge: 10 * 60,
    });
    return response;
  } catch (error) {
    console.error("[auth] could not start sign-in", describeError(error));
    return redirectHome("signin_failed");
  }
}
