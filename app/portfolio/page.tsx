import type { Metadata } from "next";
import { Suspense } from "react";

import { PendingLink } from "@/components/loader/pending";
import { MessageCard, PageShell } from "@/components/portfolio/page-shell";
import { formatTimestamp } from "@/components/portfolio/format";
import { LINK, SnapTradeProblem, waitText } from "@/components/portfolio/snaptrade-problem";
import { SCREENS } from "@/components/screens";
import {
  SNAPTRADE_DASHBOARD_URL,
  XRaySkeleton,
  XRayView,
  type XRayNotice,
} from "@/components/portfolio/xray-view";
import { isAuthConfigured } from "@/lib/auth/config";
import { describeError, procedureFailure } from "@/lib/errors";
import type { SnapshotResult } from "@/lib/portfolio/service";
import { createTrpcServerCaller } from "@/lib/trpc/server";

export const metadata: Metadata = { title: "Portfolio X-Ray · ThesisDeploy" };

// Rendering this page calls SnapTrade, so links never prefetch it.
export const prefetch = "force-disabled";
// A page already opened in this tab stays up for 10 minutes, so switching back doesn't flash the skeleton.
export const unstable_dynamicStaleTime = 600;

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
      <MessageCard title="Sign-in isn't configured on this deployment" mark="signin">
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

  const caller = await createTrpcServerCaller();
  if (!(await caller.auth.userId())) {
    return (
      <MessageCard title="Sign in to see your portfolio" mark="signin">
        <p>
          ThesisDeploy reads balances and positions from the brokerage accounts you manage in SnapTrade. It never
          trades without your confirmation.
        </p>
        <p>
          <PendingLink href={SIGN_IN} className={LINK} pendingLabel="Opening SnapTrade…">
            Sign in with SnapTrade
          </PendingLink>{" "}
          or try the{" "}
          <a href="/demo" className={LINK}>
            demo portfolio
          </a>
          .
        </p>
      </MessageCard>
    );
  }

  const requested = typeof params.account === "string" ? params.account : undefined;
  let xray;
  try {
    xray = await caller.portfolio.xray({ accountId: requested });
  } catch (error) {
    console.error("[portfolio] could not load accounts", describeError(procedureFailure(error)));
    return <SnapTradeProblem error={error} returnTo="/portfolio" />;
  }
  const { overview, selected, result, failure } = xray;

  if (!selected) {
    return (
      <MessageCard title="No investment accounts yet" mark="empty">
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

  const snapshotError = failure?.limited
    ? `This account's SnapTrade request limit (10 per minute) is used up. ${waitText(failure.retryAfterSeconds)}`
    : failure
      ? "SnapTrade couldn't return balances and positions for this account. Try again shortly."
      : undefined;

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
    <PageShell {...SCREENS.xray}>
      <Suspense fallback={<XRaySkeleton />}>
        <LiveXRay searchParams={searchParams} />
      </Suspense>
    </PageShell>
  );
}
