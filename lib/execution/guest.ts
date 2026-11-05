import { createHash, randomBytes } from "node:crypto";

import { GUEST_COOKIE, GUEST_COOKIE_MAX_AGE } from "@/constants/execution";
import { hmacHex } from "@/lib/auth/crypto";
import { serverEnv } from "@/lib/env";

export function guestKeyFor(token: string): string {
  const secret = serverEnv().SESSION_SECRET;
  const value = `demo-guest:${token}`;
  const digest = secret
    ? hmacHex(Buffer.from(secret, "base64"), value)
    : createHash("sha256").update(value).digest("hex");
  return digest.slice(0, 32);
}

export const parseGuestToken = (value: string | undefined): string | null =>
  value && /^[\w-]{20,100}$/.test(value) ? value : null;

export const newGuestToken = () => randomBytes(32).toString("base64url");

export function guestCookieHeader(token: string, secure: boolean): string {
  const parts = [`${GUEST_COOKIE}=${token}`, "Path=/", `Max-Age=${GUEST_COOKIE_MAX_AGE}`, "HttpOnly", "SameSite=Lax"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}
