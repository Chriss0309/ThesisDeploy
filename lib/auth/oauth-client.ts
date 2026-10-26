import { z } from "zod";

import type { AuthConfig } from "@/lib/auth/config";
import type { ProviderMetadata } from "@/lib/auth/discovery";

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.coerce.number().int().positive(),
  token_type: z.string().refine((type) => type.toLowerCase() === "bearer"),
  scope: z.string().optional(),
  id_token: z.string().optional(),
});

export type TokenResponse = z.infer<typeof tokenResponseSchema>;

type Operation = "token" | "refresh" | "revoke";

export class OAuthError extends Error {
  name = "OAuthError";
  constructor(
    readonly operation: Operation,
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(`OAuth ${operation} failed: HTTP ${status}${code ? ` ${code}` : ""}`);
  }
}

type Credentials = Pick<AuthConfig, "clientId" | "clientSecret">;

async function postForm(
  url: string,
  credentials: Credentials,
  body: Record<string, string>,
  operation: Operation,
): Promise<Response> {
  const basic = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString("base64");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const error = await response.json().then(
      (json: { error?: unknown }) => json?.error,
      () => undefined,
    );
    // Only well-formed OAuth error codes are kept; bodies are never logged.
    const code = typeof error === "string" && /^[a-z_]{1,64}$/.test(error) ? error : undefined;
    throw new OAuthError(operation, response.status, code);
  }
  return response;
}

async function parseTokens(response: Response, operation: Operation): Promise<TokenResponse> {
  const parsed = tokenResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new OAuthError(operation, response.status, "invalid_token_response");
  return parsed.data;
}

export async function exchangeCode(
  config: Credentials & Pick<AuthConfig, "redirectUri">,
  metadata: Pick<ProviderMetadata, "token_endpoint">,
  params: { code: string; codeVerifier: string },
): Promise<TokenResponse> {
  const response = await postForm(
    metadata.token_endpoint,
    config,
    {
      grant_type: "authorization_code",
      code: params.code,
      code_verifier: params.codeVerifier,
      redirect_uri: config.redirectUri,
    },
    "token",
  );
  return parseTokens(response, "token");
}

export async function refreshTokens(
  config: Credentials,
  metadata: Pick<ProviderMetadata, "token_endpoint">,
  refreshToken: string,
): Promise<TokenResponse> {
  const response = await postForm(
    metadata.token_endpoint,
    config,
    { grant_type: "refresh_token", refresh_token: refreshToken },
    "refresh",
  );
  return parseTokens(response, "refresh");
}

export async function revokeRefreshToken(
  config: Credentials,
  metadata: Pick<ProviderMetadata, "revocation_endpoint">,
  refreshToken: string,
): Promise<void> {
  await postForm(
    metadata.revocation_endpoint,
    config,
    { token: refreshToken, token_type_hint: "refresh_token" },
    "revoke",
  );
}
