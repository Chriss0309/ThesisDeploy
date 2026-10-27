import type { Metadata } from "next";
import { cookies } from "next/headers";
import { after, connection } from "next/server";
import { Suspense } from "react";

import { DemoBanner } from "@/components/portfolio/demo-banner";
import { MessageCard, PageShell } from "@/components/portfolio/page-shell";
import { SCREENS, ThesesSkeleton } from "@/components/screens";
import { ThesesView } from "@/components/theses/theses-view";
import { serverEnv } from "@/lib/env";
import { describeError } from "@/lib/errors";
import { GUEST_COOKIE, guestKeyFor } from "@/lib/execution/http";
import { loadTheses, recordDriftViewed } from "@/lib/theses/service";

export const metadata: Metadata = { title: "Demo theses · ThesisDeploy" };

// Valuing a basket reads the clock and the database, so links never prefetch it.
export const prefetch = "force-disabled";

async function GuestTheses() {
  if (!serverEnv().DATABASE_URL) {
    return (
      <MessageCard title="Saved baskets aren&apos;t available here" mark="empty">
        <p>This deployment has no database, so paper runs can&apos;t be saved.</p>
      </MessageCard>
    );
  }
  await connection();
  const token = (await cookies()).get(GUEST_COOKIE)?.value;
  const guestKey = token ? guestKeyFor(token) : null;
  const { cards } = guestKey ? await loadTheses({ userId: null, guestKey }) : { cards: [] };
  after(() =>
    recordDriftViewed(cards, { guestKey }).catch((error) => console.error("[theses] telemetry", describeError(error))),
  );
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
