import { z } from "zod";

import { checkImpact } from "@/lib/execution/impact";
import { ActionPreflightSchema, ImpactRequestSchema, SimulateMoveSchema } from "@/lib/execution/schema";
import { findBasketView } from "@/lib/execution/store";
import { actionPreflight, simulateMove } from "@/lib/theses/service";
import { actorProcedure, protectedProcedure, router } from "@/server/trpc";

const basketId = z.uuid();

export const basketsRouter = router({
  view: protectedProcedure
    .input(z.object({ basketId }))
    .query(({ ctx, input }) => findBasketView(input.basketId, { userId: ctx.user.id, guestKey: null })),

  /** Pre-flight for a rebalance or close of a saved basket, signed in or guest. */
  preflight: actorProcedure
    .meta({ invalidInput: "Choose rebalance or close." })
    .input(ActionPreflightSchema.extend({ basketId }))
    .mutation(({ ctx, input }) => actionPreflight(ctx.actor, input.basketId, input.kind)),

  /** Brokerage preview for a Live pre-flight. Places nothing. */
  impact: actorProcedure
    .meta({ invalidInput: "Invalid preview request." })
    .input(ImpactRequestSchema.extend({ basketId }))
    .mutation(({ ctx, input: { basketId: id, ...request } }) => checkImpact(ctx.actor, id, request)),

  /** Demo only: scale one stock's fictional price, or clear the moves. */
  simulate: actorProcedure
    .meta({ invalidInput: "Pick a stock and a price move." })
    .input(z.object({ basketId, move: SimulateMoveSchema }))
    .mutation(async ({ ctx, input }) => ({
      simulatedMoves: await simulateMove(ctx.actor, input.basketId, input.move),
    })),
});
