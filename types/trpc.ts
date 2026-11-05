import type { SessionUser } from "@/lib/auth/sessions";

export type TrpcContext = {
  user: SessionUser | null;
  sessionToken: string | null;
  guestToken: string | null;
  clientIp: string | null;
  secureCookies: boolean;
  resHeaders: Headers;
};

/** Per-procedure wording for the failures the shared middleware turns into client errors. */
export type TrpcMeta = {
  invalidInput?: string;
  signedOut?: string;
  failure?: string;
};

/** What a client can read from a failed call. */
export type ClientError = {
  code: string;
  message: string;
  retryAfterSeconds: number | null;
  executionId: string | null;
};
