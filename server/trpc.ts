import { initTRPC, TRPCError } from "@trpc/server";
import { ZodError } from "zod";

import { INTERNAL_ERROR_MESSAGE, TRPC_CODE_BY_STATUS } from "@/constants/trpc";
import { ReauthRequiredError } from "@/lib/auth/vault";
import { serverEnv } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { guestKeyFor } from "@/lib/execution/guest";
import type { TrpcContext, TrpcMeta } from "@/types/trpc";

/**
 * The only error whose details reach a client. `cause` keeps the original, so
 * Server Components calling through the server caller can still tell failures apart.
 */
export class PublicError extends TRPCError {
  constructor(
    readonly app: AppError,
    cause: unknown = app,
  ) {
    super({ code: TRPC_CODE_BY_STATUS[app.status] ?? "INTERNAL_SERVER_ERROR", message: app.message, cause });
  }
}

function toPublicError(error: TRPCError, meta: TrpcMeta | undefined): TRPCError {
  const { cause } = error;
  if (error instanceof PublicError) return error;
  if (cause instanceof AppError) return new PublicError(cause);
  if (cause instanceof ReauthRequiredError) {
    return new PublicError(
      new AppError("reauth_required", 401, "Your SnapTrade access expired. Sign in again to continue."),
      cause,
    );
  }
  if (error.code === "BAD_REQUEST" && cause instanceof ZodError) {
    return new PublicError(new AppError("invalid_request", 400, meta?.invalidInput ?? "Invalid request."), cause);
  }
  if (error.code !== "INTERNAL_SERVER_ERROR") return error;
  return new PublicError(new AppError("internal", 500, meta?.failure ?? INTERNAL_ERROR_MESSAGE), cause);
}

const t = initTRPC
  .context<TrpcContext>()
  .meta<TrpcMeta>()
  .create({
    // Messages can echo connection strings, tokens, or response bodies, and a stack
    // starts with its message. So no stack is ever sent, and an internal failure that
    // isn't a PublicError never sends its own message.
    isDev: false,
    errorFormatter({ shape, error }) {
      const app = error instanceof PublicError ? error.app : null;
      const internal = error.code === "INTERNAL_SERVER_ERROR";
      return {
        ...shape,
        message: app?.message ?? (internal ? INTERNAL_ERROR_MESSAGE : shape.message),
        data: {
          ...shape.data,
          appCode: app?.code ?? (internal ? "internal" : error.code.toLowerCase()),
          retryAfterSeconds: app?.extra.retryAfterSeconds ?? null,
          executionId: app?.extra.executionId ?? null,
        },
      };
    },
  });

const publicErrors = t.middleware(async ({ meta, next }) => {
  const result = await next();
  if (!result.ok) throw toPublicError(result.error, meta);
  return result;
});

const requireDatabase = t.middleware(({ next }) => {
  if (!serverEnv().DATABASE_URL) {
    throw new AppError(
      "not_configured",
      503,
      "Paper execution needs the database, which isn't configured on this deployment.",
    );
  }
  return next();
});

export const router = t.router;
export const createCallerFactory = t.createCallerFactory;

export const publicProcedure = t.procedure.use(publicErrors);

export const protectedProcedure = publicProcedure.use(({ ctx, meta, next }) => {
  if (!ctx.user) throw new AppError("signed_out", 401, meta?.signedOut ?? "Sign in to continue.");
  return next({ ctx: { user: ctx.user } });
});

export const databaseProcedure = publicProcedure.use(requireDatabase);

export const protectedDatabaseProcedure = protectedProcedure.use(requireDatabase);

/** A signed-in user, a guest, or both: whoever may own a basket or execution. */
export const actorProcedure = databaseProcedure.use(({ ctx, next }) =>
  next({
    ctx: {
      actor: { userId: ctx.user?.id ?? null, guestKey: ctx.guestToken ? guestKeyFor(ctx.guestToken) : null },
    },
  }),
);
