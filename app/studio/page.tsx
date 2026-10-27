import type { Metadata } from "next";
import { Suspense } from "react";

import { PendingLink } from "@/components/loader/pending";
import { MessageCard, PageShell } from "@/components/portfolio/page-shell";
import { LINK, SnapTradeProblem } from "@/components/portfolio/snaptrade-problem";
import { SNAPTRADE_DASHBOARD_URL } from "@/components/portfolio/xray-view";
import { ThesisStudio } from "@/components/thesis/thesis-studio";
import { SCREENS, STUDIO_LOADING, StudioSkeleton } from "@/components/screens";
import { isAuthConfigured } from "@/lib/auth/config";
import { getCurrentUser } from "@/lib/auth/current-user";
import { ReauthRequiredError } from "@/lib/auth/vault";
import { configuredFeatures, serverEnv } from "@/lib/env";
import { describeError } from "@/lib/errors";
import { getSnapshot, loadOverview } from "@/lib/portfolio/service";
import { snapTradeContext } from "@/lib/snaptrade/client";
import { USER_GENERATIONS_PER_DAY } from "@/lib/thesis/rate-limit";
import { initialStudioAccount, toStudioAccount } from "@/lib/thesis/portfolio";

export const metadata: Metadata = { title: "Thesis Studio · ThesisDeploy" };

// Rendering this page calls SnapTrade, so links never prefetch it.
export const prefetch = "force-disabled";
// A page already opened in this tab stays up for 10 minutes, so switching back doesn't flash the skeleton.
export const unstable_dynamicStaleTime = 600;

const SIGN_IN = "/api/auth/login?returnTo=/studio";

async function LiveStudio({ searchParams }: { searchParams: PageProps<"/studio">["searchParams"] }) {
  const { account: requested, preset } = await searchParams;
  if (!isAuthConfigured()) {
    return (
      <MessageCard title="Sign-in isn't configured on this deployment" mark="signin">
        <p>
          Try the{" "}
          <a href="/demo/studio" className={LINK}>
            demo Thesis Studio
          </a>{" "}
          on a fictional portfolio.
        </p>
      </MessageCard>
    );
  }
  const user = await getCurrentUser();
  if (!user) {
    return (
      <MessageCard title="Sign in to build a basket on your portfolio" mark="signin">
        <p>
          The Studio reads your holdings across every connected account so it can flag and trim what you already own.
        </p>
        <p>
          <PendingLink href={SIGN_IN} className={LINK} pendingLabel="Opening SnapTrade…">
            Sign in with SnapTrade
          </PendingLink>{" "}
          or try the{" "}
          <a href="/demo/studio" className={LINK}>
            demo Studio
          </a>
          .
        </p>
      </MessageCard>
    );
  }

  const ctx = snapTradeContext(user.id);
  let accounts;
  try {
    const overview = await loadOverview(ctx);
    // The overlap check needs every account anyway; snapshots are cached for 10 minutes,
    // so the generate request that follows reuses them.
    const snapshots = await Promise.allSettled(overview.accounts.map((account) => getSnapshot(ctx, account)));
    accounts = overview.accounts.map((account, i) => {
      const result = snapshots[i];
      if (result.status === "rejected") {
        if (result.reason instanceof ReauthRequiredError) throw result.reason;
        console.error("[studio] snapshot unavailable", describeError(result.reason));
      }
      return toStudioAccount({ account, snapshot: result.status === "fulfilled" ? result.value.snapshot : null });
    });
  } catch (error) {
    console.error("[studio] could not load accounts", describeError(error));
    return <SnapTradeProblem error={error} returnTo="/studio" />;
  }

  if (accounts.length === 0) {
    return (
      <MessageCard title="No investment accounts yet" mark="empty">
        <p>
          Connect a brokerage in the{" "}
          <a href={SNAPTRADE_DASHBOARD_URL} className={LINK} target="_blank" rel="noreferrer">
            SnapTrade Dashboard
          </a>
          , then come back.
        </p>
      </MessageCard>
    );
  }

  const anthropic = configuredFeatures(serverEnv()).anthropic;
  return (
    <ThesisStudio
      mode="live"
      endpoint="/api/theses"
      accounts={accounts}
      initialAccountId={initialStudioAccount(accounts, requested).id}
      initialPresetKey={typeof preset === "string" ? preset : null}
      generation={
        anthropic
          ? { presets: true, custom: true, note: `Each generation calls ThesisDeploy's AI; up to ${USER_GENERATIONS_PER_DAY} per day.` }
          : {
              presets: false,
              custom: false,
              note: "Thesis generation isn't configured on this deployment yet (no Anthropic key).",
            }
      }
    />
  );
}

export default function StudioPage({ searchParams }: PageProps<"/studio">) {
  return (
    <PageShell {...SCREENS.studio}>
      <Suspense fallback={<StudioSkeleton {...STUDIO_LOADING} />}>
        <LiveStudio searchParams={searchParams} />
      </Suspense>
    </PageShell>
  );
}
