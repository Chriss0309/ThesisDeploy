import type { Metadata } from "next";
import { Suspense } from "react";

import { MessageCard, PageShell } from "@/components/portfolio/page-shell";
import { LINK, SnapTradeProblem } from "@/components/portfolio/snaptrade-problem";
import { SCREENS, ThesesSkeleton } from "@/components/screens";
import { ThesesView } from "@/components/theses/theses-view";
import { isAuthConfigured } from "@/lib/auth/config";
import { serverEnv } from "@/lib/env";
import { describeError, procedureFailure } from "@/lib/errors";
import { createTrpcServerCaller } from "@/lib/trpc/server";

export const metadata: Metadata = { title: "My Theses · ThesisDeploy" };

// Rendering this page calls SnapTrade for quotes, so links never prefetch it.
export const prefetch = "force-disabled";
// A page already opened in this tab stays up for 10 minutes, so switching back doesn't flash the skeleton.
export const unstable_dynamicStaleTime = 600;

async function SignedInTheses() {
  if (!isAuthConfigured()) {
    return (
      <MessageCard title="Sign-in isn't configured on this deployment" mark="signin">
        <p>
          Try the{" "}
          <a href="/demo/theses" className={LINK}>
            demo My Theses
          </a>{" "}
          with a fictional basket.
        </p>
      </MessageCard>
    );
  }
  const caller = await createTrpcServerCaller();
  if (!(await caller.auth.userId())) {
    return (
      <MessageCard title="Sign in to see your theses" mark="signin">
        <p>
          <a href="/api/auth/login?returnTo=/theses" className={LINK}>
            Sign in with SnapTrade
          </a>{" "}
          or open the{" "}
          <a href="/demo/theses" className={LINK}>
            demo
          </a>
          .
        </p>
      </MessageCard>
    );
  }
  if (!serverEnv().DATABASE_URL) {
    return (
      <MessageCard title="Saved baskets aren't available here" mark="empty">
        <p>This deployment has no database, so paper runs can&apos;t be saved.</p>
      </MessageCard>
    );
  }
  let cards;
  try {
    cards = await caller.theses.list();
  } catch (error) {
    console.error("[theses] could not load", describeError(procedureFailure(error)));
    return <SnapTradeProblem error={error} returnTo="/theses" />;
  }
  return <ThesesView cards={cards} demo={false} />;
}

export default function ThesesPage() {
  return (
    <PageShell {...SCREENS.theses}>
      <Suspense fallback={<ThesesSkeleton />}>
        <SignedInTheses />
      </Suspense>
    </PageShell>
  );
}
