import { after } from "next/server";
import { z } from "zod";

import { INVALID_THESIS_MESSAGE, THESIS_FAILURE_MESSAGE } from "@/constants/thesis";
import { AppError, describeError } from "@/lib/errors";
import { snapTradeContext } from "@/lib/snaptrade/client";
import { recordEvent } from "@/lib/telemetry/events";
import { loadTheses, recordDriftViewed } from "@/lib/theses/service";
import { EditSchema } from "@/lib/thesis/edits";
import { ThesisRequestSchema } from "@/lib/thesis/schema";
import { createThesis } from "@/lib/thesis/service";
import { thesisOwnedBy } from "@/lib/thesis/store";
import { protectedProcedure, router } from "@/server/trpc";

export const thesesRouter = router({
  create: protectedProcedure
    .meta({
      invalidInput: INVALID_THESIS_MESSAGE,
      signedOut: "Sign in with SnapTrade to generate a thesis.",
      failure: THESIS_FAILURE_MESSAGE,
    })
    .input(ThesisRequestSchema)
    .mutation(({ ctx, input }) => createThesis(snapTradeContext(ctx.user.id), input)),

  /** Feeds the basket edit rate: suggested tickers removed or resized before deploying. */
  recordEdit: protectedProcedure
    .meta({ invalidInput: "Invalid edit.", signedOut: "Sign in to record edits." })
    .input(EditSchema.extend({ thesisId: z.uuid() }))
    .mutation(async ({ ctx, input: { thesisId, ...edit } }) => {
      if (!(await thesisOwnedBy(thesisId, ctx.user.id))) throw new AppError("not_found", 404, "Thesis not found.");
      await recordEvent("basket_edited", { thesisId, ...edit }, ctx.user.id);
    }),

  list: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.user.id;
    const { cards } = await loadTheses({ userId, guestKey: null }, { ctx: snapTradeContext(userId) });
    after(() =>
      recordDriftViewed(cards, { userId }).catch((error) => console.error("[theses] telemetry", describeError(error))),
    );
    return cards;
  }),
});
