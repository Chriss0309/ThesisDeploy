import { NextResponse, type NextRequest } from "next/server";

export const STATE_COOKIE = "td_oauth_state";

export type AuthNotice =
  | "signed_out"
  | "disconnected"
  | "disconnect_partial"
  | "not_configured"
  | "access_denied"
  | "state_mismatch"
  | "signin_failed";

// Relative Location headers keep same-site redirects independent of how the
// host is reported (self-hosted `next start` reports localhost for every request).
export function redirectTo(location: string): NextResponse {
  return new NextResponse(null, {
    status: 303,
    headers: { Location: location, "Cache-Control": "no-store" },
  });
}

export function redirectHome(notice?: AuthNotice): NextResponse {
  return redirectTo(notice ? `/?auth=${notice}` : "/");
}

// The origin the browser used, from the proxy headers Vercel and `next start` set.
export function publicOrigin(request: NextRequest): string {
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const proto =
    request.headers.get("x-forwarded-proto") ?? request.nextUrl.protocol.replace(":", "");
  if (!host) return request.nextUrl.origin;
  return `${proto.split(",")[0].trim()}://${host.split(",")[0].trim()}`;
}

// Vercel sets both headers from the connecting client and overwrites any
// value the client sent, so they can't be spoofed there.
export function clientIp(request: NextRequest): string | null {
  return request.headers.get("x-real-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
}

export function noStore<T extends Response>(response: T): T {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export const isSecure = (url: string | URL) => new URL(url).protocol === "https:";
