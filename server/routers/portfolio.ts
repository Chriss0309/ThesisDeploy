import { z } from "zod";

import { ReauthRequiredError } from "@/lib/auth/vault";
import { describeError } from "@/lib/errors";
import { getSnapshot, loadOverview } from "@/lib/portfolio/service";
import { SnapTradeError, snapTradeContext } from "@/lib/snaptrade/client";
import { toStudioAccount } from "@/lib/thesis/portfolio";
import { protectedProcedure, publicProcedure, router } from "@/server/trpc";

const isRateLimited = (error: unknown): error is SnapTradeError =>
  error instanceof SnapTradeError && (error.code === "rate_limited" || error.code === "budget_exhausted");

export const portfolioRouter = router({
  /** One account's balances and positions. `accountId` falls back to the first account. */
  xray: protectedProcedure.input(z.object({ accountId: z.string().optional() })).query(async ({ ctx, input }) => {
    const snaptrade = snapTradeContext(ctx.user.id);
    const overview = await loadOverview(snaptrade);
    const selected = overview.accounts.find((account) => account.id === input.accountId) ?? overview.accounts[0] ?? null;
    if (!selected) return { overview, selected, result: null, failure: null };
    try {
      return { overview, selected, result: await getSnapshot(snaptrade, selected), failure: null };
    } catch (error) {
      if (error instanceof ReauthRequiredError) throw error;
      console.error("[portfolio] could not load snapshot", describeError(error));
      const failure = isRateLimited(error)
        ? { limited: true, retryAfterSeconds: error.retryAfterSeconds }
        : { limited: false, retryAfterSeconds: null };
      return { overview, selected, result: null, failure };
    }
  }),

  /** Every account with its holdings, for the Studio's overlap check. */
  studioAccounts: protectedProcedure.query(async ({ ctx }) => {
    const snaptrade = snapTradeContext(ctx.user.id);
    const overview = await loadOverview(snaptrade);
    // The overlap check needs every account anyway; snapshots are cached for 10 minutes,
    // so the generate request that follows reuses them.
    const snapshots = await Promise.allSettled(overview.accounts.map((account) => getSnapshot(snaptrade, account)));
    return overview.accounts.map((account, i) => {
      const result = snapshots[i];
      if (result.status === "rejected") {
        if (result.reason instanceof ReauthRequiredError) throw result.reason;
        console.error("[studio] snapshot unavailable", describeError(result.reason));
      }
      return toStudioAccount({ account, snapshot: result.status === "fulfilled" ? result.value.snapshot : null });
    });
  }),

  /** Refetches one account and says where to land, with the outcome in the query string. */
  refreshAccount: publicProcedure.input(z.object({ accountId: z.string() })).mutation(async ({ ctx, input }) => {
    if (!ctx.user) return { location: "/portfolio" };
    const query = new URLSearchParams({ account: input.accountId });
    try {
      const snaptrade = snapTradeContext(ctx.user.id);
      // The account list proves the account belongs to this user and supplies the
      // brokerage for telemetry; it isn't account-scoped, so it doesn't spend the budget.
      const account = (await loadOverview(snaptrade)).accounts.find((candidate) => candidate.id === input.accountId);
      if (!account) return { location: "/portfolio" };

      const result = await getSnapshot(snaptrade, account, { refresh: true });
      if (result.warning) {
        query.set("notice", result.warning.reason);
        if (result.warning.retryAfterSeconds) query.set("retry", String(result.warning.retryAfterSeconds));
      } else {
        query.set("notice", "refreshed");
      }
    } catch (error) {
      console.error("[portfolio] refresh failed", describeError(error));
      const limited = isRateLimited(error);
      query.set("notice", limited ? "rate_limited" : "unavailable");
      if (limited && error.retryAfterSeconds) query.set("retry", String(error.retryAfterSeconds));
    }
    return { location: `/portfolio?${query}` };
  }),
});
