import type { Metadata } from "next";
import { cookies } from "next/headers";
import { after } from "next/server";
import { Suspense } from "react";

import { DemoBanner } from "@/components/portfolio/demo-banner";
import { MessageCard, PageShell } from "@/components/portfolio/page-shell";
import { ThesesView } from "@/components/theses/theses-view";
import { serverEnv } from "@/lib/env";
import { describeError } from "@/lib/errors";
import { GUEST_COOKIE, guestKeyFor } from "@/lib/execution/http";
import { loadTheses, recordDriftViewed } from "@/lib/theses/service";

export const metadata: Metadata = { title: "Demo theses · ThesisDeploy" };

async function GuestTheses() {
  if (!serverEnv().DATABASE_URL) {
    return (
      <MessageCard title="Saved baskets aren&apos;t available here">
        <p>This deployment has no database, so paper runs can&apos;t be saved.</p>
      </MessageCard>
    );
  }
  const token = (await cookies()).get(GUEST_COOKIE)?.value;
  const { cards } = token ? await loadTheses({ userId: null, guestKey: guestKeyFor(token) }) : { cards: [] };
  after(() => recordDriftViewed(cards, null).catch((error) => console.error("[theses] telemetry", describeError(error))));
  return <ThesesView cards={cards} demo />;
}

export default function DemoThesesPage() {
  return (
    <PageShell
      eyebrow="04 · Guest demo"
      title="My Theses"
      description="Your saved demo baskets, valued at fictional quotes against what you paid, with drift from each target and a one-click rebalance."
      banner={<DemoBanner active="theses" returnTo="/theses" />}
    >
      <Suspense fallback={<div className="h-96 animate-pulse rounded-lg bg-muted" aria-hidden />}>
        <GuestTheses />
      </Suspense>
      <p className="text-xs text-muted-foreground">Demo baskets belong to this browser and use paper money only.</p>
    </PageShell>
  );
}
