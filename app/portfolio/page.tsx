import type { Metadata } from "next";
import { Suspense } from "react";

import { MessageCard, PageShell } from "@/components/portfolio/page-shell";
import { formatTimestamp } from "@/components/portfolio/format";
import { LINK, SnapTradeProblem, waitText } from "@/components/portfolio/snaptrade-problem";
import {
  SNAPTRADE_DASHBOARD_URL,
  XRaySkeleton,
  XRayView,
  type XRayNotice,
} from "@/components/portfolio/xray-view";
import { isAuthConfigured } from "@/lib/auth/config";
import { getCurrentUser } from "@/lib/auth/current-user";
import { ReauthRequiredError } from "@/lib/auth/vault";
import { describeError } from "@/lib/errors";
import { getSnapshot, loadOverview, type SnapshotResult } from "@/lib/portfolio/service";
import { SnapTradeError, snapTradeContext } from "@/lib/snaptrade/client";

export const metadata: Metadata = { title: "Portfolio X-Ray · ThesisDeploy" };

// Rendering this page calls SnapTrade, so links never prefetch it.
export const prefetch = "force-disabled";

type SearchParams = PageProps<"/portfolio">["searchParams"];

const SIGN_IN = "/api/auth/login?returnTo=/portfolio";

function noticeFor(
  result: SnapshotResult | null,
  params: Record<string, string | string[] | undefined>,
): XRayNotice | undefined {
  if (result?.warning) {
    const cachedAt = formatTimestamp(result.snapshot.fetchedAt);
    return result.warning.reason === "rate_limited"
      ? {
          tone: "warn",
          text: `Showing data cached at ${cachedAt}: this account's SnapTrade request limit (10 per minute) is used up. ${waitText(result.warning.retryAfterSeconds)}`,
        }
      : { tone: "warn", text: `Showing data cached at ${cachedAt} because SnapTrade couldn't be reached.` };
  }
  if (params.notice === "refreshed") return { tone: "info", text: "Refreshed from SnapTrade." };
  if (params.notice === "rate_limited") {
    const retry = Number(params.retry);
    return {
      tone: "warn",
      text: `Not refreshed: this account's SnapTrade request limit (10 per minute) is used up. ${waitText(Number.isFinite(retry) ? retry : null)}`,
    };
  }
  if (params.notice === "unavailable") {
    return { tone: "warn", text: "Not refreshed: SnapTrade couldn't be reached. Showing the last data we have." };
  }
  return undefined;
}

async function LiveXRay({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  if (!isAuthConfigured()) {
    return (
      <MessageCard title="Sign-in isn't configured on this deployment">
        <p>
          You can still explore the{" "}
          <a href="/demo" className={LINK}>
            demo portfolio
          </a>
          .
        </p>
      </MessageCard>
    );
  }

  const user = await getCurrentUser();
  if (!user) {
    return (
      <MessageCard title="Sign in to see your portfolio">
        <p>
          ThesisDeploy reads balances and positions from the brokerage accounts you manage in SnapTrade. It never
          trades without your confirmation.
        </p>
        <p>
          <a href={SIGN_IN} className={LINK}>
            Sign in with SnapTrade
          </a>{" "}
          or try the{" "}
          <a href="/demo" className={LINK}>
            demo portfolio
          </a>
          .
        </p>
      </MessageCard>
    );
  }

  const ctx = snapTradeContext(user.id);
  let overview;
  try {
    overview = await loadOverview(ctx);
  } catch (error) {
    console.error("[portfolio] could not load accounts", describeError(error));
    return <SnapTradeProblem error={error} returnTo="/portfolio" />;
  }

  if (overview.accounts.length === 0) {
    return (
      <MessageCard title="No investment accounts yet">
        <p>
          Connect a brokerage in the{" "}
          <a href={SNAPTRADE_DASHBOARD_URL} className={LINK} target="_blank" rel="noreferrer">
            SnapTrade Dashboard
          </a>
          , then come back. Connections you add there are available to ThesisDeploy right away.
        </p>
      </MessageCard>
    );
  }

  const requested = typeof params.account === "string" ? params.account : undefined;
  const selected = overview.accounts.find((account) => account.id === requested) ?? overview.accounts[0];
  let result: SnapshotResult | null = null;
  let snapshotError: string | undefined;
  try {
    result = await getSnapshot(ctx, selected);
  } catch (error) {
    if (error instanceof ReauthRequiredError) return <SnapTradeProblem error={error} returnTo="/portfolio" />;
    console.error("[portfolio] could not load snapshot", describeError(error));
    snapshotError =
      error instanceof SnapTradeError && (error.code === "rate_limited" || error.code === "budget_exhausted")
        ? `This account's SnapTrade request limit (10 per minute) is used up. ${waitText(error.retryAfterSeconds)}`
        : "SnapTrade couldn't return balances and positions for this account. Try again shortly.";
  }

  return (
    <XRayView
      mode="live"
      overview={overview}
      selected={selected}
      result={result}
      basePath="/portfolio"
      notice={noticeFor(result, params)}
      snapshotError={snapshotError}
    />
  );
}

export default function PortfolioPage({ searchParams }: PageProps<"/portfolio">) {
  return (
    <PageShell
      title="Portfolio X-Ray"
      description="Cash, buying power, positions, and concentration for each connected account."
    >
      <Suspense fallback={<XRaySkeleton />}>
        <LiveXRay searchParams={searchParams} />
      </Suspense>
    </PageShell>
  );
}
