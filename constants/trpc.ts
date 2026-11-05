import type { TRPCError } from "@trpc/server";

export const TRPC_ENDPOINT = "/api/trpc";

export const INTERNAL_ERROR_MESSAGE = "Something went wrong. Try again.";

/** Procedures that stream their result; every other call uses the plain link so it can set cookies. */
export const STREAMED_PROCEDURES = new Set(["executions.drain"]);

export const TRPC_CODE_BY_STATUS: Record<number, TRPCError["code"]> = {
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  422: "UNPROCESSABLE_CONTENT",
  429: "TOO_MANY_REQUESTS",
  500: "INTERNAL_SERVER_ERROR",
  502: "BAD_GATEWAY",
  503: "SERVICE_UNAVAILABLE",
};
