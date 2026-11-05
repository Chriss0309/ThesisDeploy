import { z } from "zod";

import { describeError } from "@/lib/errors";
import { drainExecution } from "@/lib/execution/drain";
import { liveSubmitter } from "@/lib/execution/live-orders";
import { reconcileExecution } from "@/lib/execution/reconcile";
import {
  CreateExecutionSchema,
  IdempotencyKeySchema,
  PreflightRequestSchema,
  RetryRequestSchema,
} from "@/lib/execution/schema";
import { cancelExecution, createExecution, preflightForUser, requireExecution, retryLeg } from "@/lib/execution/service";
import type { OwnedExecution } from "@/lib/execution/store";
import { snapTradeContext } from "@/lib/snaptrade/client";
import { actorProcedure, protectedDatabaseProcedure, router } from "@/server/trpc";
import type { DrainEvent } from "@/types/execution";

const executionInput = z.object({ executionId: z.uuid() });

async function* drainEvents(owned: OwnedExecution, signal: AbortSignal | undefined): AsyncGenerator<DrainEvent> {
  const live =
    owned.view.mode === "live" && owned.userId
      ? liveSubmitter(snapTradeContext(owned.userId), {
          accountId: owned.accountId,
          brokerageSlug: owned.brokerageSlug,
          institution: owned.view.institution,
        })
      : undefined;
  try {
    yield* drainExecution(owned, { signal, live });
  } catch (error) {
    console.error("[drain] stopped", describeError(error));
    yield { type: "error", code: "internal", message: "The queue stopped unexpectedly. Resume to continue." };
  }
}

export const executionsRouter = router({
  preflight: protectedDatabaseProcedure
    .meta({
      invalidInput: "Check the basket, then try pre-flight again.",
      signedOut: "Sign in with SnapTrade to run pre-flight.",
    })
    .input(PreflightRequestSchema)
    .mutation(({ ctx, input }) => preflightForUser(snapTradeContext(ctx.user.id), input)),

  get: actorProcedure.input(executionInput).query(async ({ ctx, input }) => {
    const owned = await requireExecution(ctx.actor, input.executionId);
    return owned.view;
  }),

  /** Confirms a pre-flight. Repeating an `idempotencyKey` returns the same execution. */
  create: actorProcedure
    .meta({ invalidInput: "Invalid execution request." })
    .input(CreateExecutionSchema.extend({ idempotencyKey: IdempotencyKeySchema }))
    .mutation(async ({ ctx, input }) => {
      const { execution } = await createExecution(ctx.actor, input);
      return execution;
    }),

  /**
   * Streams progress while it submits pending legs. The loop stops claiming legs
   * after 45 seconds, and the client calls again to resume.
   */
  drain: actorProcedure.input(executionInput).mutation(async ({ ctx, input, signal }) => {
    const owned = await requireExecution(ctx.actor, input.executionId);
    return drainEvents(owned, signal);
  }),

  /** Skips the legs that haven't been submitted; filled legs stay in the basket. */
  cancel: actorProcedure
    .input(executionInput)
    .mutation(({ ctx, input }) => cancelExecution(ctx.actor, input.executionId)),

  /**
   * Checks a Live execution's open orders at the broker. At most one SnapTrade
   * call per 15 seconds per execution; earlier calls return the current state
   * and `nextCheckAt`.
   */
  reconcile: actorProcedure
    .input(executionInput)
    .mutation(({ ctx, input }) => reconcileExecution(ctx.actor, input.executionId)),

  /**
   * Queues a new attempt, with a new client_order_id, for a rejected or failed
   * leg; an unconfirmed Live leg needs `confirmNotPlaced`. Drain to submit it.
   */
  retryLeg: actorProcedure
    .meta({ invalidInput: "Invalid retry request." })
    .input(executionInput.extend({ legId: z.uuid(), options: RetryRequestSchema }))
    .mutation(({ ctx, input }) => retryLeg(ctx.actor, input.executionId, input.legId, input.options)),
});
