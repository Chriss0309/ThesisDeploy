import { cookies } from "next/headers";

import { getAuthConfig, isAuthConfigured } from "@/lib/auth/config";
import { SESSION_COOKIE, findSessionUser, type SessionUser } from "@/lib/auth/sessions";

export async function getCurrentUser(): Promise<SessionUser | null> {
  if (!isAuthConfigured()) return null;
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return findSessionUser(getAuthConfig(), token);
}
