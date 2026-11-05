import { after } from "next/server";
import { z } from "zod";

import { INVALID_THESIS_MESSAGE, THESIS_FAILURE_MESSAGE } from "@/constants/thesis";
import { serverEnv } from "@/lib/env";
import { AppError, describeError } from "@/lib/errors";
import { guestCookieHeader, guestKeyFor, newGuestToken } from "@/lib/execution/guest";
import { PreflightRequestSchema } from "@/lib/execution/schema";
import { preflightForGuest } from "@/lib/execution/service";
import { findBasketView } from "@/lib/execution/store";
import { recordEvent } from "@/lib/telemetry/events";
import { loadTheses, recordDriftViewed } from "@/lib/theses/service";
import { GuestEditSchema, servedToGuest } from "@/lib/thesis/edits";
import { guestClientKey } from "@/lib/thesis/rate-limit";
import { ThesisRequestSchema } from "@/lib/thesis/schema";
import { createDemoThesis } from "@/lib/thesis/service";
import { databaseProcedure, publicProcedure, router } from "@/server/trpc";

export const demoRouter = router({
  createThesis: publicProcedure
    .meta({ invalidInput: INVALID_THESIS_MESSAGE, failure: THESIS_FAILURE_MESSAGE })
    .input(ThesisRequestSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.clientIp && !input.presetKey) {
        throw new AppError("unknown_client", 400, "Custom prompts need a client address. Try a preset.");
      }
      // Issue the demo cookie with the first basket, so pre-flight can't mint a second
      // one in parallel and the basket's telemetry already belongs to this visitor.
      const token = ctx.guestToken ?? newGuestToken();
      const payload = await createDemoThesis(input, {
        client: guestClientKey(ctx.clientIp ?? "unknown"),
        key: guestKeyFor(token),
      });
      if (!ctx.guestToken) ctx.resHeaders.append("Set-Cookie", guestCookieHeader(token, ctx.secureCookies));
      return payload;
    }),

  preflight: databaseProcedure
    .meta({ invalidInput: "Check the basket, then try pre-flight again." })
    .input(PreflightRequestSchema)
    .mutation(async ({ ctx, input }) => {
      const token = ctx.guestToken ?? newGuestToken();
      const payload = await preflightForGuest(
        {
          guestKey: guestKeyFor(token),
          // Daily limits follow the visitor's address, so clearing cookies doesn't reset them.
          guestClient: guestClientKey(ctx.clientIp ?? `cookie:${token}`),
        },
        input,
      );
      if (!ctx.guestToken) ctx.resHeaders.append("Set-Cookie", guestCookieHeader(token, ctx.secureCookies));
      return payload;
    }),

  /** The guest demo's side of the basket edit rate, keyed by the demo cookie. */
  recordEdit: publicProcedure
    .meta({ invalidInput: "Invalid edit." })
    .input(GuestEditSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.guestToken) throw new AppError("no_demo_session", 401, "Generate a demo basket first.");
      if (!serverEnv().DATABASE_URL) return;
      const guestKey = guestKeyFor(ctx.guestToken);
      if (!(await servedToGuest(guestKey, input.ref))) throw new AppError("not_found", 404, "Basket not found.");
      await recordEvent("basket_edited", input, { guestKey });
    }),

  theses: publicProcedure.query(async ({ ctx }) => {
    const guestKey = ctx.guestToken ? guestKeyFor(ctx.guestToken) : null;
    const { cards } = guestKey ? await loadTheses({ userId: null, guestKey }) : { cards: [] };
    after(() =>
      recordDriftViewed(cards, { guestKey }).catch((error) => console.error("[theses] telemetry", describeError(error))),
    );
    return cards;
  }),

  basket: publicProcedure.input(z.object({ basketId: z.uuid() })).query(({ ctx, input }) => {
    if (!ctx.guestToken) return null;
    return findBasketView(input.basketId, { userId: null, guestKey: guestKeyFor(ctx.guestToken) });
  }),
});
