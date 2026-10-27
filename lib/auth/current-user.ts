import { cookies } from "next/headers";
import { connection } from "next/server";

import { getAuthConfig, isAuthConfigured } from "@/lib/auth/config";
import { SESSION_COOKIE, findSessionUser, type SessionUser } from "@/lib/auth/sessions";

export async function getCurrentUser(): Promise<SessionUser | null> {
  if (!isAuthConfigured()) return null;
  // Session expiry compares against the current time, which Cache Components
  // only allows at request time; cookies alone are also readable in prefetches.
  await connection();
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return findSessionUser(getAuthConfig(), token);
}
