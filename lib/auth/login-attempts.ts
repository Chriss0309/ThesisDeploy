import type { AuthConfig } from "@/lib/auth/config";
import { decrypt, encrypt } from "@/lib/auth/crypto";
import { getDb } from "@/lib/db/client";

const ATTEMPT_TTL_MS = 10 * 60 * 1000;

const verifierContext = (state: string) => `oauth_login_attempts.code_verifier:${state}`;

export type LoginAttempt = {
  state: string;
  codeVerifier: string;
  nonce: string;
  returnTo: string;
};

export async function createLoginAttempt(
  config: Pick<AuthConfig, "tokenKey">,
  attempt: LoginAttempt,
): Promise<void> {
  const db = getDb();
  await db.oauthLoginAttempt.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  await db.oauthLoginAttempt.create({
    data: {
      state: attempt.state,
      codeVerifierEnc: encrypt(config.tokenKey, attempt.codeVerifier, verifierContext(attempt.state)),
      nonce: attempt.nonce,
      returnTo: attempt.returnTo,
      expiresAt: new Date(Date.now() + ATTEMPT_TTL_MS),
    },
  });
}

type AttemptRow = {
  codeVerifierEnc: string;
  nonce: string;
  returnTo: string | null;
  expiresAt: Date;
};

// Single use: the row is deleted even when it has expired, so a replayed
// callback finds nothing.
export async function consumeLoginAttempt(
  config: Pick<AuthConfig, "tokenKey">,
  state: string,
): Promise<LoginAttempt | null> {
  const [row] = await getDb().$transaction(
    (tx) => tx.$queryRaw<AttemptRow[]>`
      delete from oauth_login_attempts
      where state = ${state}
      returning code_verifier_enc as "codeVerifierEnc",
                nonce,
                return_to as "returnTo",
                expires_at as "expiresAt"
    `,
  );
  if (!row || row.expiresAt <= new Date()) return null;
  return {
    state,
    codeVerifier: decrypt(config.tokenKey, row.codeVerifierEnc, verifierContext(state)),
    nonce: row.nonce,
    returnTo: row.returnTo ?? "/",
  };
}
