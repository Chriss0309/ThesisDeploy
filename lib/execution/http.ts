import { createHash, randomBytes } from "node:crypto";

import type { NextRequest } from "next/server";

import { hmacHex } from "@/lib/auth/crypto";
import { getCurrentUser } from "@/lib/auth/current-user";
import { isSecure, publicOrigin } from "@/lib/auth/http";
import { ReauthRequiredError } from "@/lib/auth/vault";
import { serverEnv } from "@/lib/env";
import { describeError } from "@/lib/errors";
import { ExecutionError, type Actor } from "@/lib/execution/store";
import type { ExecutionErrorBody } from "@/lib/execution/types";

/** Owns guest demo baskets. Random, httpOnly; only its keyed hash is stored. */
export const GUEST_COOKIE = "td_guest";
const GUEST_COOKIE_MAX_AGE = 30 * 24 * 3600;

export function guestKeyFor(token: string): string {
  const secret = serverEnv().SESSION_SECRET;
  const value = `demo-guest:${token}`;
  const digest = secret
    ? hmacHex(Buffer.from(secret, "base64"), value)
    : createHash("sha256").update(value).digest("hex");
  return digest.slice(0, 32);
}

export function guestToken(request: NextRequest): string | null {
  const token = request.cookies.get(GUEST_COOKIE)?.value;
  return token && /^[\w-]{20,100}$/.test(token) ? token : null;
}

export const newGuestToken = () => randomBytes(32).toString("base64url");

export function withGuestCookie(response: Response, request: NextRequest, token: string): Response {
  const parts = [
    `${GUEST_COOKIE}=${token}`,
    "Path=/",
    `Max-Age=${GUEST_COOKIE_MAX_AGE}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (isSecure(publicOrigin(request))) parts.push("Secure");
  response.headers.append("Set-Cookie", parts.join("; "));
  return response;
}

export async function resolveActor(request: NextRequest): Promise<Actor> {
  const token = guestToken(request);
  const user = await getCurrentUser();
  return { userId: user?.id ?? null, guestKey: token ? guestKeyFor(token) : null };
}

export function errorResponse(
  status: number,
  code: string,
  message: string,
  extra: { retryAfterSeconds?: number | null; executionId?: string | null } = {},
): Response {
  const body: ExecutionErrorBody = { error: { code, message, ...extra } };
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (extra.retryAfterSeconds) headers["Retry-After"] = String(Math.ceil(extra.retryAfterSeconds));
  return Response.json(body, { status, headers });
}

/**
 * Same-origin requests only, and a database to queue in. Cookies are
 * SameSite=Lax, so cross-site POSTs arrive without a session anyway.
 */
export function guardRequest(request: NextRequest, { json = false } = {}): Response | null {
  const origin = request.headers.get("origin");
  if (origin && origin !== publicOrigin(request)) {
    return errorResponse(403, "cross_origin", "Cross-origin requests are not allowed.");
  }
  if (json && !request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return errorResponse(415, "unsupported_media_type", "Send JSON.");
  }
  if (!serverEnv().DATABASE_URL) {
    return errorResponse(
      503,
      "not_configured",
      "Paper execution needs the database, which isn't configured on this deployment.",
    );
  }
  return null;
}

export function executionErrorResponse(error: unknown, scope: string): Response {
  if (error instanceof ExecutionError) {
    return errorResponse(error.status, error.code, error.message, error.extra);
  }
  if (error instanceof ReauthRequiredError) {
    return errorResponse(401, "reauth_required", "Your SnapTrade access expired. Sign in again to continue.");
  }
  console.error(`[${scope}] failed`, describeError(error));
  return errorResponse(500, "internal", "Something went wrong. Try again.");
}

export const noStoreJson = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
