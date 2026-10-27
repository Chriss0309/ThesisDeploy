import type { AuthConfig } from "@/lib/auth/config";
import { hmacHex, randomToken } from "@/lib/auth/crypto";
import { getDb } from "@/lib/db/client";

export const SESSION_COOKIE = "td_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type SessionKeyConfig = Pick<AuthConfig, "sessionKey">;

// Keyed with SESSION_SECRET so write access to the table alone cannot mint a session.
const sessionId = (config: SessionKeyConfig, token: string) => hmacHex(config.sessionKey, token);

export type SessionUser = {
  id: string;
  snaptradeUserId: string;
  email: string | null;
  emailVerified: boolean | null;
  name: string | null;
};

export async function createSession(
  config: SessionKeyConfig,
  userId: string,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await getDb().session.create({ data: { id: sessionId(config, token), userId, expiresAt } });
  return { token, expiresAt };
}

export async function findSessionUser(
  config: SessionKeyConfig,
  token: string,
): Promise<SessionUser | null> {
  const session = await getDb().session.findUnique({
    where: { id: sessionId(config, token), revokedAt: null, expiresAt: { gt: new Date() } },
    select: {
      user: {
        select: { id: true, snaptradeUserId: true, email: true, emailVerified: true, name: true },
      },
    },
  });
  return session?.user ?? null;
}

export async function revokeSession(config: SessionKeyConfig, token: string): Promise<void> {
  await getDb().session.updateMany({
    where: { id: sessionId(config, token), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function revokeUserSessions(userId: string): Promise<void> {
  await getDb().session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export function sessionCookie(token: string, expiresAt: Date, secure: boolean) {
  return {
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "lax" as const,
    secure,
    path: "/",
    expires: expiresAt,
  };
}
