import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";

import { DemoBanner } from "@/components/portfolio/demo-banner";
import { MessageCard, PageShell } from "@/components/portfolio/page-shell";
import { SCREENS, ThesesSkeleton } from "@/components/screens";
import { ThesesView } from "@/components/theses/theses-view";
import { serverEnv } from "@/lib/env";
import { createTrpcServerCaller } from "@/lib/trpc/server";

export const metadata: Metadata = { title: "Demo theses · ThesisDeploy" };

// Valuing a basket reads the clock and the database, so links never prefetch it.
export const prefetch = "force-disabled";
// A page already opened in this tab stays up for 10 minutes, so switching back doesn't flash the skeleton.
export const unstable_dynamicStaleTime = 600;

async function GuestTheses() {
  if (!serverEnv().DATABASE_URL) {
    return (
      <MessageCard title="Saved baskets aren&apos;t available here" mark="empty">
        <p>This deployment has no database, so paper runs can&apos;t be saved.</p>
      </MessageCard>
    );
  }
  // The server context only calls this when sign-in is configured, and valuing a basket reads the clock.
  await connection();
  const caller = await createTrpcServerCaller();
  const cards = await caller.demo.theses();
  return <ThesesView cards={cards} demo />;
}

export default function DemoThesesPage() {
  return (
    <PageShell
      {...SCREENS.thesesDemo}
      banner={<DemoBanner active="theses" returnTo="/theses" />}
    >
      <Suspense fallback={<ThesesSkeleton demo />}>
        <GuestTheses />
      </Suspense>
      <p className="text-xs text-muted-foreground">Demo baskets belong to this browser and use paper money only.</p>
    </PageShell>
  );
}
