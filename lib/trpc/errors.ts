import { TRPCClientError } from "@trpc/client";

import type { AppRouter } from "@/server";
import type { ClientError } from "@/types/trpc";

const isClientError = (caught: unknown): caught is TRPCClientError<AppRouter> => caught instanceof TRPCClientError;

/** The server's error, or null when the call never reached it and the caller should say so. */
export function readClientError(caught: unknown): ClientError | null {
  if (!isClientError(caught) || !caught.data) return null;
  const { appCode, retryAfterSeconds, executionId } = caught.data;
  return { code: appCode, message: caught.message, retryAfterSeconds, executionId };
}
