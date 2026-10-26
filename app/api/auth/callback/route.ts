import { connection, type NextRequest } from "next/server";

import { getAuthConfig } from "@/lib/auth/config";
import { completeLogin } from "@/lib/auth/flow";
import { STATE_COOKIE, isSecure, redirectHome, redirectTo } from "@/lib/auth/http";
import { sessionCookie } from "@/lib/auth/sessions";

export const maxDuration = 30;

export async function GET(request: NextRequest) {
  await connection();
  let config;
  try {
    config = getAuthConfig();
  } catch {
    return redirectHome("not_configured");
  }

  const params = request.nextUrl.searchParams;
  const result = await completeLogin(
    config,
    {
      code: params.get("code"),
      state: params.get("state"),
      error: params.get("error"),
      iss: params.get("iss"),
    },
    request.cookies.get(STATE_COOKIE)?.value,
  );

  const response = result.ok ? redirectTo(result.returnTo) : redirectHome(result.error);
  response.cookies.delete({ name: STATE_COOKIE, path: "/api/auth" });
  if (result.ok) {
    response.cookies.set(
      sessionCookie(result.session.token, result.session.expiresAt, isSecure(config.redirectUri)),
    );
  }
  return response;
}
