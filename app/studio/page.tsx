import type { Metadata } from "next";
import { Suspense } from "react";

import { PendingLink } from "@/components/loader/pending";
import { MessageCard, PageShell } from "@/components/portfolio/page-shell";
import { LINK, SnapTradeProblem } from "@/components/portfolio/snaptrade-problem";
import { SNAPTRADE_DASHBOARD_URL } from "@/components/portfolio/xray-view";
import { ThesisStudio } from "@/components/thesis/thesis-studio";
import { SCREENS, STUDIO_LOADING, StudioSkeleton } from "@/components/screens";
import { isAuthConfigured } from "@/lib/auth/config";
import { configuredFeatures, serverEnv } from "@/lib/env";
import { describeError, procedureFailure } from "@/lib/errors";
import { USER_GENERATIONS_PER_DAY } from "@/lib/thesis/rate-limit";
import { initialStudioAccount } from "@/lib/thesis/portfolio";
import { createTrpcServerCaller } from "@/lib/trpc/server";

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
  const caller = await createTrpcServerCaller();
  const userId = await caller.auth.userId();
  if (!userId) {
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

  let accounts;
  try {
    accounts = await caller.portfolio.studioAccounts();
  } catch (error) {
    console.error("[studio] could not load accounts", describeError(procedureFailure(error)));
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
      snapshotScope={`live:${userId}`}
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
