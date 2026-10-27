import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { z } from "zod";

import { BasketRecord } from "@/components/execution/basket-record";
import { DemoBanner } from "@/components/portfolio/demo-banner";
import { MessageCard, PageShell } from "@/components/portfolio/page-shell";
import { LINK } from "@/components/portfolio/snaptrade-problem";
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
  return <BasketRecord basket={basket} studioPath="/demo/studio" />;
}

export default function DemoBasketPage({ params }: PageProps<"/demo/baskets/[basketId]">) {
  return (
    <PageShell
      eyebrow="03 · Guest demo"
      title="Virtual basket"
      description="The orders you confirmed, the fills they produced, and the execution that placed them."
      banner={<DemoBanner active="studio" returnTo="/studio" />}
    >
      <Suspense fallback={<div className="h-96 animate-pulse rounded-lg bg-muted" aria-hidden />}>
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
