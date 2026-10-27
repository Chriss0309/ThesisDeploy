import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { z } from "zod";

import { BasketRecord } from "@/components/execution/basket-record";
import { DemoBanner } from "@/components/portfolio/demo-banner";
import { MessageCard, PageShell } from "@/components/portfolio/page-shell";
import { LINK } from "@/components/portfolio/snaptrade-problem";
import { BasketSkeleton, SCREENS } from "@/components/screens";
import { serverEnv } from "@/lib/env";
import { GUEST_COOKIE, guestKeyFor } from "@/lib/execution/http";
import { findBasketView } from "@/lib/execution/store";

export const metadata: Metadata = { title: "Demo basket · ThesisDeploy" };

async function GuestBasket({ params }: { params: PageProps<"/demo/baskets/[basketId]">["params"] }) {
  const { basketId } = await params;
  if (!serverEnv().DATABASE_URL) {
    return (
      <MessageCard title="Saved baskets aren&apos;t available here">
        <p>This deployment has no database, so paper runs can&apos;t be saved.</p>
      </MessageCard>
    );
  }
  const token = (await cookies()).get(GUEST_COOKIE)?.value;
  if (!token || !z.uuid().safeParse(basketId).success) notFound();
  const basket = await findBasketView(basketId, { userId: null, guestKey: guestKeyFor(token) });
  if (!basket) notFound();
  return <BasketRecord basket={basket} studioPath="/demo/studio" thesesPath="/demo/theses" />;
}

export default function DemoBasketPage({ params }: PageProps<"/demo/baskets/[basketId]">) {
  return (
    <PageShell {...SCREENS.basketDemo} banner={<DemoBanner active="studio" returnTo="/studio" />}>
      <Suspense fallback={<BasketSkeleton />}>
        <GuestBasket params={params} />
      </Suspense>
      <p className="text-xs text-muted-foreground">
        Demo baskets belong to this browser. Lost it?{" "}
        <a href="/demo/studio" className={LINK}>
          Build another one
        </a>
        .
      </p>
    </PageShell>
  );
}
