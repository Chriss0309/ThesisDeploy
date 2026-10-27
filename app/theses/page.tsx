import type { Metadata } from "next";
import { after } from "next/server";
import { Suspense } from "react";

import { MessageCard, PageShell } from "@/components/portfolio/page-shell";
import { LINK, SnapTradeProblem } from "@/components/portfolio/snaptrade-problem";
import { ThesesView } from "@/components/theses/theses-view";
import { isAuthConfigured } from "@/lib/auth/config";
import { getCurrentUser } from "@/lib/auth/current-user";
import { serverEnv } from "@/lib/env";
import { describeError } from "@/lib/errors";
import { snapTradeContext } from "@/lib/snaptrade/client";
import { loadTheses, recordDriftViewed } from "@/lib/theses/service";

export const metadata: Metadata = { title: "My Theses · ThesisDeploy" };

// Rendering this page calls SnapTrade for quotes, so links never prefetch it.
export const prefetch = "force-disabled";

async function SignedInTheses() {
  if (!isAuthConfigured()) {
    return (
      <MessageCard title="Sign-in isn't configured on this deployment">
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
  const user = await getCurrentUser();
  if (!user) {
    return (
      <MessageCard title="Sign in to see your theses">
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
      <MessageCard title="Saved baskets aren't available here">
        <p>This deployment has no database, so paper runs can&apos;t be saved.</p>
      </MessageCard>
    );
  }
  let cards;
  try {
    ({ cards } = await loadTheses({ userId: user.id, guestKey: null }, { ctx: snapTradeContext(user.id) }));
  } catch (error) {
    console.error("[theses] could not load", describeError(error));
    return <SnapTradeProblem error={error} returnTo="/theses" />;
  }
  after(() => recordDriftViewed(cards, user.id).catch((error) => console.error("[theses] telemetry", describeError(error))));
  return <ThesesView cards={cards} demo={false} />;
}

export default function ThesesPage() {
  return (
    <PageShell
      eyebrow="04 · My Theses"
      title="My Theses"
      description="Your saved baskets, valued at current prices against what you paid, with drift from each target and a one-click rebalance."
    >
      <Suspense fallback={<div className="h-96 animate-pulse rounded-lg bg-muted" aria-hidden />}>
        <SignedInTheses />
      </Suspense>
    </PageShell>
  );
}
