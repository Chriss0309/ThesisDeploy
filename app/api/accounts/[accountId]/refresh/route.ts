import type { NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth/current-user";
import { publicOrigin, redirectTo } from "@/lib/auth/http";
import { describeError } from "@/lib/errors";
import { getSnapshot, loadOverview } from "@/lib/portfolio/service";
import { SnapTradeError, snapTradeContext } from "@/lib/snaptrade/client";

export const maxDuration = 30;

export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/accounts/[accountId]/refresh">,
) {
  const origin = request.headers.get("origin");
  if (origin && origin !== publicOrigin(request)) {
    return new Response("Cross-origin refresh rejected", { status: 403 });
  }

  const { accountId } = await context.params;
  const user = await getCurrentUser();
  if (!user) return redirectTo("/portfolio");

  const query = new URLSearchParams({ account: accountId });
  try {
    const ctx = snapTradeContext(user.id);
    // The account list proves the account belongs to this user and supplies the
    // brokerage for telemetry; it isn't account-scoped, so it doesn't spend the budget.
    const account = (await loadOverview(ctx)).accounts.find((candidate) => candidate.id === accountId);
    if (!account) return redirectTo("/portfolio");

    const result = await getSnapshot(ctx, account, { refresh: true });
    if (result.warning) {
      query.set("notice", result.warning.reason);
      if (result.warning.retryAfterSeconds) query.set("retry", String(result.warning.retryAfterSeconds));
    } else {
      query.set("notice", "refreshed");
    }
  } catch (error) {
    console.error("[portfolio] refresh failed", describeError(error));
    const limited =
      error instanceof SnapTradeError && (error.code === "rate_limited" || error.code === "budget_exhausted");
    query.set("notice", limited ? "rate_limited" : "unavailable");
    if (limited && error.retryAfterSeconds) query.set("retry", String(error.retryAfterSeconds));
  }
  return redirectTo(`/portfolio?${query}`);
}
