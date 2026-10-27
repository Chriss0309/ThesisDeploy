import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { z } from "zod";

import { BasketRecord } from "@/components/execution/basket-record";
import { MessageCard, PageShell } from "@/components/portfolio/page-shell";
import { LINK } from "@/components/portfolio/snaptrade-problem";
import { isAuthConfigured } from "@/lib/auth/config";
import { getCurrentUser } from "@/lib/auth/current-user";
import { findBasketView } from "@/lib/execution/store";

export const metadata: Metadata = { title: "Virtual basket · ThesisDeploy" };

async function SignedInBasket({ params }: { params: PageProps<"/baskets/[basketId]">["params"] }) {
  const { basketId } = await params;
  const user = isAuthConfigured() ? await getCurrentUser() : null;
  if (!user) {
    return (
      <MessageCard title="Sign in to see this basket">
        <p>
          <a href={`/api/auth/login?returnTo=/baskets/${encodeURIComponent(basketId)}`} className={LINK}>
            Sign in with SnapTrade
          </a>{" "}
          to open your saved baskets.
        </p>
      </MessageCard>
    );
  }
  if (!z.uuid().safeParse(basketId).success) notFound();
  const basket = await findBasketView(basketId, { userId: user.id, guestKey: null });
  if (!basket) notFound();
  return <BasketRecord basket={basket} studioPath="/studio" />;
}

export default function BasketPage({ params }: PageProps<"/baskets/[basketId]">) {
  return (
    <PageShell
      eyebrow="03 · Saved basket"
      title="Virtual basket"
      description="The orders you confirmed, the fills they produced, and the execution that placed them."
    >
      <Suspense fallback={<div className="h-96 animate-pulse rounded-lg bg-muted" aria-hidden />}>
        <SignedInBasket params={params} />
      </Suspense>
    </PageShell>
  );
}
